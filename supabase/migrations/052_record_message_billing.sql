-- ============================================================
-- 052_record_message_billing.sql — record_message_billing(), the
-- write path for the message_billing table (051).
--
-- NOT wired to the webhook yet — that's step 3, deliberately deferred
-- until after 1 October 2026 when Meta's `pricing.type` vocabulary
-- change lands and can be observed against a live payload. This
-- migration only adds the function; nothing calls it.
--
-- Logic, in order:
--   1. Resolve the WABA's timezone from whatsapp_config (falls back
--      to the column default if the phone number has no config row —
--      shouldn't happen, since the webhook only ever calls this for a
--      phone number it already matched a config for, but a missing
--      row must not crash the insert).
--   2. Compute billing_month = first-of-month in THAT timezone, not
--      the server's. A message sent at 02:00 Asia/Dubai on the 1st
--      must land in that month even when the DB server's clock is UTC
--      (where the same instant is still 22:00 the day before).
--   3. Take a transaction-scoped advisory lock keyed on
--      (phone_number_id, billing_month) BEFORE counting free-tier
--      usage. Two concurrent inbound deliveries for the same phone
--      number in the same month would otherwise both read "999 used,
--      still free" and both insert as free, over-crediting the tier
--      by one — a JS-side (or naive SQL-side) count-then-insert has
--      exactly this race. The lock serializes them; whichever commits
--      second sees the first's row in its count.
--   4. Look up rate_card for this category, hardcoded to market='UAE'
--      (see 051's note — no per-account market field exists yet),
--      picking the newest `effective_from` at or before this
--      message's OWN billing month — so a late-arriving or replayed
--      event prices at the rate that applied when it was sent, not
--      whatever rate is current when the row happens to be written.
--   5. Cost:
--        billable = false           -> 0, unconditionally
--        category = 'service'
--          and < 1,000 counted this (phone_number_id, billing_month)
--          -> 0 (free tier)
--        otherwise                  -> rate_usd
--   6. Insert with ON CONFLICT (phone_number_id, message_id, category)
--      DO NOTHING — replay safety lives on this constraint, not on
--      any caller-side status ladder (see the audit's note on
--      message_id non-uniqueness). A replay returns no row.
--
-- Idempotent — CREATE OR REPLACE throughout.
-- ============================================================

CREATE OR REPLACE FUNCTION public.record_message_billing(
  p_account_id      UUID,
  p_phone_number_id TEXT,
  p_message_id      TEXT,
  p_pricing_type    TEXT,
  p_category        TEXT,
  p_billable        BOOLEAN,
  p_pricing_model   TEXT,
  p_sent_at         TIMESTAMPTZ
) RETURNS SETOF message_billing
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_timezone      TEXT;
  v_billing_month DATE;
  v_rate_usd      NUMERIC(10,6);
  v_free_used     INTEGER;
  v_cost_usd      NUMERIC(10,6);
BEGIN
  SELECT timezone INTO v_timezone
  FROM whatsapp_config
  WHERE phone_number_id = p_phone_number_id;

  IF v_timezone IS NULL THEN
    v_timezone := 'Asia/Dubai';
  END IF;

  -- First-of-month in the WABA's own timezone. `AT TIME ZONE` on a
  -- timestamptz converts to that zone's local wall-clock time (as a
  -- plain timestamp), which date_trunc then floors to the 1st.
  v_billing_month := date_trunc('month', p_sent_at AT TIME ZONE v_timezone)::date;

  -- Serialize concurrent calls for this (phone_number_id,
  -- billing_month) — see header comment. Released automatically at
  -- transaction end; a plain function call is its own transaction
  -- unless the caller wraps several in one, which is fine either way.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_phone_number_id || ':' || v_billing_month::text, 0)
  );

  SELECT rate_usd INTO v_rate_usd
  FROM rate_card
  WHERE market = 'UAE'
    AND category = p_category
    AND effective_from <= v_billing_month
  ORDER BY effective_from DESC
  LIMIT 1;

  IF v_rate_usd IS NULL THEN
    v_rate_usd := 0;
  END IF;

  IF NOT p_billable THEN
    v_cost_usd := 0;
  ELSIF p_category = 'service' THEN
    SELECT count(*) INTO v_free_used
    FROM message_billing
    WHERE phone_number_id = p_phone_number_id
      AND billing_month = v_billing_month
      AND category = 'service';

    v_cost_usd := CASE WHEN v_free_used < 1000 THEN 0 ELSE v_rate_usd END;
  ELSE
    v_cost_usd := v_rate_usd;
  END IF;

  RETURN QUERY
  INSERT INTO message_billing (
    account_id, phone_number_id, message_id, pricing_type, category,
    billable, pricing_model, rate_usd, cost_usd, billing_month, sent_at
  )
  VALUES (
    p_account_id, p_phone_number_id, p_message_id, p_pricing_type, p_category,
    p_billable, p_pricing_model, v_rate_usd, v_cost_usd, v_billing_month, p_sent_at
  )
  ON CONFLICT (phone_number_id, message_id, category) DO NOTHING
  RETURNING *;
END;
$$;

ALTER FUNCTION public.record_message_billing(
  UUID, TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT, TIMESTAMPTZ
) OWNER TO postgres;

-- Only the service role (webhook, step 3) ever calls this — same
-- grant pattern as reset_ai_session_if_stale (048) /
-- bump_conversation_on_inbound (037). No `authenticated` grant: an
-- account member has no business minting billing rows for their own
-- account.
REVOKE ALL ON FUNCTION public.record_message_billing(
  UUID, TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT, TIMESTAMPTZ
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_message_billing(
  UUID, TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT, TIMESTAMPTZ
) FROM anon;
REVOKE ALL ON FUNCTION public.record_message_billing(
  UUID, TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT, TIMESTAMPTZ
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.record_message_billing(
  UUID, TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT, TIMESTAMPTZ
) TO service_role;
