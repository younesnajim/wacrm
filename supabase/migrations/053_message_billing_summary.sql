-- ============================================================
-- 053_message_billing_summary.sql — get_message_billing_summary(),
-- the read path for the cost dashboard card (Settings → WhatsApp).
--
-- One function, one round trip: total cost, per-category count/cost,
-- free-tier usage, and a projected month-end figure for the CALLER's
-- account, for the account's current billing month (computed in its
-- own WABA timezone, same convention as record_message_billing() —
-- migration 052).
--
-- Unlike record_message_billing() (service-role only), this is called
-- directly by an admin's own browser session via supabase.rpc(), so
-- auth.uid() reflects the real caller. A SECURITY DEFINER function
-- bypasses table RLS entirely, so the admin+ gate has to be enforced
-- INSIDE the function body — there is no RLS policy on a function
-- call. This mirrors ai_usage_log_select's admin+ read exactly, just
-- expressed as an explicit check instead of a table policy.
--
-- message_billing has no rows for any account until the webhook is
-- wired (step 3, after 1 October 2026) — `has_data` tells the caller
-- whether to render real numbers or the "cost tracking hasn't started"
-- empty state. It reflects the account EVER having a row, not just
-- this month, so the UI doesn't need special-casing once real rows
-- start arriving mid-month.
--
-- Idempotent — CREATE OR REPLACE.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_message_billing_summary(
  p_account_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_timezone      TEXT;
  v_local_now     TIMESTAMP;
  v_billing_month DATE;
  v_days_elapsed  INT;
  v_days_in_month INT;
  v_has_data      BOOLEAN;
  v_total_count   BIGINT;
  v_total_cost    NUMERIC(12,6);
  v_free_used     BIGINT;
  v_by_category   JSONB;
BEGIN
  IF NOT is_account_member(p_account_id, 'admin') THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;

  -- Same timezone convention as record_message_billing(): whatsapp_config
  -- is one row per account (UNIQUE(account_id), migration 017), so a
  -- direct account_id lookup is simpler than that function's
  -- phone_number_id one. Falls back to the column default if the
  -- account hasn't configured WhatsApp yet.
  SELECT timezone INTO v_timezone
  FROM whatsapp_config
  WHERE account_id = p_account_id;

  IF v_timezone IS NULL THEN
    v_timezone := 'Asia/Dubai';
  END IF;

  v_local_now := now() AT TIME ZONE v_timezone;
  v_billing_month := date_trunc('month', v_local_now)::date;
  v_days_elapsed := EXTRACT(DAY FROM v_local_now)::int;
  -- Last day-of-month's day number = total days in the month.
  v_days_in_month := EXTRACT(
    DAY FROM (date_trunc('month', v_local_now) + INTERVAL '1 month - 1 day')
  )::int;

  SELECT EXISTS (
    SELECT 1 FROM message_billing WHERE account_id = p_account_id
  ) INTO v_has_data;

  SELECT
    count(*),
    coalesce(sum(cost_usd), 0),
    count(*) FILTER (WHERE category = 'service')
  INTO v_total_count, v_total_cost, v_free_used
  FROM message_billing
  WHERE account_id = p_account_id
    AND billing_month = v_billing_month;

  -- Always all four categories, zero-filled — same "known slots always
  -- present" shape as ai_usage_log's by_mode (033), so the UI never has
  -- to guess which rows are missing.
  SELECT jsonb_agg(
    jsonb_build_object(
      'category', cat.category,
      'count', coalesce(agg.cnt, 0),
      'cost_usd', coalesce(agg.cost, 0)
    ) ORDER BY cat.ord
  )
  INTO v_by_category
  FROM (VALUES
    ('marketing', 1), ('service', 2), ('utility', 3), ('authentication', 4)
  ) AS cat(category, ord)
  LEFT JOIN (
    SELECT category, count(*) AS cnt, sum(cost_usd) AS cost
    FROM message_billing
    WHERE account_id = p_account_id
      AND billing_month = v_billing_month
    GROUP BY category
  ) agg ON agg.category = cat.category;

  RETURN jsonb_build_object(
    'billing_month', v_billing_month,
    'has_data', v_has_data,
    'days_elapsed', v_days_elapsed,
    'days_in_month', v_days_in_month,
    'total_count', v_total_count,
    'total_cost_usd', v_total_cost,
    'free_tier_used', v_free_used,
    'free_tier_limit', 1000,
    'projected_cost_usd',
      CASE WHEN v_days_elapsed > 0
        THEN round(v_total_cost / v_days_elapsed * v_days_in_month, 6)
        ELSE 0
      END,
    'by_category', v_by_category
  );
END;
$$;

ALTER FUNCTION public.get_message_billing_summary(UUID) OWNER TO postgres;

-- Called directly by an admin's own session (the Settings card, via
-- supabase.rpc()) — unlike record_message_billing(), `authenticated`
-- IS the right grantee here. The admin+ check above is what actually
-- gates access; this grant just lets the call reach the function body.
REVOKE ALL ON FUNCTION public.get_message_billing_summary(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_message_billing_summary(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_message_billing_summary(UUID) TO authenticated;
