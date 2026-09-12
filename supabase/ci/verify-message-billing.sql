-- Functional checks for record_message_billing() and
-- get_message_billing_summary() (migrations 051-053), run in CI
-- against a freshly-migrated database — see
-- .github/workflows/migrations.yml.
--
-- This is NOT a schema smoke test like verify-schema.sql (that file's
-- own header explains why it stays thin). Neither function has a
-- TypeScript caller exercised by the vitest suite yet — the webhook
-- wiring is deliberately deferred to step 3, after 1 October 2026 —
-- so this SQL-level check is the only place a bug in their
-- timezone/free-tier/rate/aggregation logic would be caught before it
-- ships. In particular: a message sent at 02:00 Asia/Dubai on the 1st
-- must bill into THAT month, not the previous one (the server/CI
-- runner's own clock is UTC, where the same instant is still the last
-- day of the prior month) — that's the specific defect the first
-- block below exists to catch.
--
-- get_message_billing_summary() is checked against ROWS DATED AT
-- now(), not a fixed calendar date: its own "current billing month" is
-- always today's, whatever today happens to be when CI runs, so
-- pinning it to e.g. 2026-10-05 the way the record_message_billing()
-- checks do would silently stop testing anything real once that date
-- is in the past. The marketing rate it's checked against is looked
-- up live from rate_card rather than hardcoded, so the assertion holds
-- on both sides of the 1 October 2026 rate change.
--
-- Same constraint as verify-schema.sql: EXACTLY ONE top-level
-- statement (`supabase db query --file` sends the whole file as one
-- prepared statement). Everything — fixtures, calls, assertions —
-- lives inside the single DO block below.
DO $$
DECLARE
  v_owner_id       UUID := gen_random_uuid();
  v_account_id     UUID;
  v_owner_id2      UUID := gen_random_uuid();
  v_account_id2    UUID;
  v_row            message_billing;
  v_count          INTEGER;
  v_summary        JSONB;
  v_current_rate   NUMERIC(10,6);
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

  -- get_message_billing_summary() is called directly by an admin's own
  -- session in production (auth.uid() set by PostgREST from their
  -- JWT), and re-checks is_account_member() itself since a SECURITY
  -- DEFINER function bypasses RLS. Run outside PostgREST here — this
  -- script executes as a plain superuser connection — auth.uid()
  -- would otherwise read NULL and every call below would raise
  -- Forbidden. Simulate the owner's own session the same way
  -- Supabase's local pgTAP examples do: stamp the JWT claims GUC.
  -- is_local=true scopes it to this transaction only.
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_owner_id)::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_owner_id::text, true);

  -- ---- empty state: no message_billing rows yet ----------------------
  -- The page must render "cost tracking hasn't started" rather than
  -- zeros until the first real row lands — has_data is what it
  -- switches on.
  IF (get_message_billing_summary(v_account_id)->>'has_data')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'expected has_data=false for an account with no message_billing rows yet';
  END IF;

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

  -- ==================================================================
  -- get_message_billing_summary() — a second, independent account so
  -- these checks don't inherit the first block's fixed-date rows
  -- (which land in whatever month 2026-10 turns out to be relative to
  -- "now", not necessarily the function's own current billing month).
  -- ==================================================================
  INSERT INTO auth.users (id, email)
    VALUES (v_owner_id2, 'billing-ci-fixture-2@example.com');
  SELECT account_id INTO v_account_id2 FROM profiles WHERE user_id = v_owner_id2;
  IF v_account_id2 IS NULL THEN
    RAISE EXCEPTION 'fixture setup failed: no account was created for the second test user';
  END IF;
  INSERT INTO whatsapp_config (account_id, user_id, phone_number_id, access_token, timezone)
    VALUES (v_account_id2, v_owner_id2, 'pn-billing-ci-2', 'enc', 'Asia/Dubai');

  -- Switch the simulated session to this account's own owner —
  -- is_account_member() must see auth.uid() = v_owner_id2 here, not
  -- the first account's owner.
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_owner_id2)::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_owner_id2::text, true);

  IF (get_message_billing_summary(v_account_id2)->>'has_data')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'expected has_data=false for a fresh second account with no rows';
  END IF;

  -- One billable marketing message (no free tier applies) and one
  -- billable service message (covered by the free tier), both sent
  -- "now" — the real current billing month, whatever it is.
  PERFORM record_message_billing(
    v_account_id2, 'pn-billing-ci-2', 'wamid.NOW-MKT', 'marketing', 'marketing',
    true, 'CBP', now()
  );
  PERFORM record_message_billing(
    v_account_id2, 'pn-billing-ci-2', 'wamid.NOW-SVC', 'service', 'service',
    true, 'CBP', now()
  );

  -- Looked up live rather than hardcoded — whether "now" falls before
  -- or after the 1 October 2026 rate change, this is whatever
  -- record_message_billing() itself would have used.
  SELECT rate_usd INTO v_current_rate
  FROM rate_card
  WHERE market = 'UAE' AND category = 'marketing'
    AND effective_from <= date_trunc('month', now() AT TIME ZONE 'Asia/Dubai')::date
  ORDER BY effective_from DESC
  LIMIT 1;

  v_summary := get_message_billing_summary(v_account_id2);

  IF (v_summary->>'has_data')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'expected has_data=true once message_billing rows exist, got %', v_summary;
  END IF;
  IF (v_summary->>'total_count')::int IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'expected total_count=2, got %', v_summary->>'total_count';
  END IF;
  IF (v_summary->>'free_tier_used')::int IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION
      'expected free_tier_used=1 (one service message), got %', v_summary->>'free_tier_used';
  END IF;
  IF (v_summary->>'total_cost_usd')::numeric IS DISTINCT FROM v_current_rate THEN
    RAISE EXCEPTION
      'expected total_cost_usd (%) to equal the single marketing message''s current rate (%)',
      v_summary->>'total_cost_usd', v_current_rate;
  END IF;
  IF jsonb_array_length(v_summary->'by_category') IS DISTINCT FROM 4 THEN
    RAISE EXCEPTION
      'expected by_category to always list all 4 categories zero-filled, got % entries',
      jsonb_array_length(v_summary->'by_category');
  END IF;

  RAISE NOTICE 'get_message_billing_summary() checks passed';
END
$$;
