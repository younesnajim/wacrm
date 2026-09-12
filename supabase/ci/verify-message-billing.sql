-- Functional checks for record_message_billing() (migrations 051/052),
-- run in CI against a freshly-migrated database — see
-- .github/workflows/migrations.yml.
--
-- This is NOT a schema smoke test like verify-schema.sql (that file's
-- own header explains why it stays thin). record_message_billing()
-- has no TypeScript caller yet — the webhook wiring is deliberately
-- deferred to step 3, after 1 October 2026 — so this SQL-level check
-- is the only place a bug in its timezone/free-tier/rate logic would
-- be caught before it ships. In particular: a message sent at 02:00
-- Asia/Dubai on the 1st must bill into THAT month, not the previous
-- one (the server/CI runner's own clock is UTC, where the same
-- instant is still the last day of the prior month) — that's the
-- specific defect this file exists to catch.
--
-- Same constraint as verify-schema.sql: EXACTLY ONE top-level
-- statement (`supabase db query --file` sends the whole file as one
-- prepared statement). Everything — fixtures, calls, assertions —
-- lives inside the single DO block below.
DO $$
DECLARE
  v_owner_id   UUID := gen_random_uuid();
  v_account_id UUID;
  v_row        message_billing;
  v_count      INTEGER;
BEGIN
  -- ---- fixture: one account + one WABA config in Asia/Dubai --------
  -- Inserting into auth.users fires on_auth_user_created
  -- (handle_new_user(), migration 044+), which already creates this
  -- user's personal account + profile — accounts(owner_user_id) is
  -- UNIQUE (017), so a second manual INSERT INTO accounts here would
  -- conflict with it. Read back the account the trigger created
  -- instead of making our own.
  INSERT INTO auth.users (id, email)
    VALUES (v_owner_id, 'billing-ci-fixture@example.com');
  SELECT account_id INTO v_account_id FROM profiles WHERE user_id = v_owner_id;
  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'fixture setup failed: no account was created for the test user';
  END IF;
  INSERT INTO whatsapp_config (account_id, user_id, phone_number_id, access_token, timezone)
    VALUES (v_account_id, v_owner_id, 'pn-billing-ci', 'enc', 'Asia/Dubai');

  -- ---- the case this file exists for --------------------------------
  -- 2026-10-01 02:00 +04:00 is 2026-09-30 22:00 UTC. Bucketing by
  -- server/UTC time would place this message in September; bucketing
  -- by the WABA's own Asia/Dubai timezone must place it in October.
  -- Values match the real payload captured against a live number.
  SELECT * INTO v_row FROM record_message_billing(
    v_account_id, 'pn-billing-ci', 'wamid.OCT1', 'free_customer_service',
    'service', false, 'PMP', '2026-10-01T02:00:00+04:00'::timestamptz
  );

  IF v_row.billing_month IS DISTINCT FROM DATE '2026-10-01' THEN
    RAISE EXCEPTION
      'expected billing_month 2026-10-01 for a 02:00 Asia/Dubai send on the 1st, got %',
      v_row.billing_month;
  END IF;

  IF v_row.cost_usd IS DISTINCT FROM 0::numeric(10,6) THEN
    RAISE EXCEPTION 'billable=false must cost 0 regardless of tier, got %', v_row.cost_usd;
  END IF;

  -- ---- replay safety: the unique constraint, not a status ladder ----
  PERFORM record_message_billing(
    v_account_id, 'pn-billing-ci', 'wamid.OCT1', 'free_customer_service',
    'service', false, 'PMP', '2026-10-01T02:00:00+04:00'::timestamptz
  );
  SELECT count(*) INTO v_count FROM message_billing WHERE message_id = 'wamid.OCT1';
  IF v_count <> 1 THEN
    RAISE EXCEPTION
      'replaying the same (phone_number_id, message_id, category) must not duplicate the row, found % rows',
      v_count;
  END IF;

  -- ---- free tier: the first billable service message this month is $0
  SELECT * INTO v_row FROM record_message_billing(
    v_account_id, 'pn-billing-ci', 'wamid.FREE1', 'service', 'service',
    true, 'CBP', '2026-10-05T10:00:00+04:00'::timestamptz
  );
  IF v_row.cost_usd IS DISTINCT FROM 0::numeric(10,6) THEN
    RAISE EXCEPTION
      'a billable service message under the 1,000/month free tier must cost 0, got %',
      v_row.cost_usd;
  END IF;

  -- ---- rate lookup: a billable non-service message costs the seeded rate
  SELECT * INTO v_row FROM record_message_billing(
    v_account_id, 'pn-billing-ci', 'wamid.MKT1', 'marketing', 'marketing',
    true, 'CBP', '2026-10-05T10:00:00+04:00'::timestamptz
  );
  IF v_row.rate_usd IS DISTINCT FROM 0.0499::numeric(10,6) THEN
    RAISE EXCEPTION 'expected the seeded UAE marketing rate 0.0499, got %', v_row.rate_usd;
  END IF;
  IF v_row.cost_usd IS DISTINCT FROM 0.0499::numeric(10,6) THEN
    RAISE EXCEPTION
      'a billable non-service message has no free tier and must cost the full rate, got %',
      v_row.cost_usd;
  END IF;

  -- ---- pre-October messages price at the seeded zero rate -----------
  SELECT * INTO v_row FROM record_message_billing(
    v_account_id, 'pn-billing-ci', 'wamid.PRE1', 'service', 'service',
    true, 'CBP', '2026-09-15T10:00:00+04:00'::timestamptz
  );
  IF v_row.rate_usd IS DISTINCT FROM 0::numeric(10,6)
     OR v_row.cost_usd IS DISTINCT FROM 0::numeric(10,6) THEN
    RAISE EXCEPTION
      'a pre-October message must price at the seeded 0 rate, got rate % cost %',
      v_row.rate_usd, v_row.cost_usd;
  END IF;

  RAISE NOTICE 'record_message_billing() checks passed';
END
$$;
