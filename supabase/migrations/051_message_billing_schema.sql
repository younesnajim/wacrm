-- ============================================================
-- 051_message_billing_schema.sql — WhatsApp message-cost schema
--
-- Foundation for the per-client cost dashboard. Adds:
--
--   1. whatsapp_config.timezone — the WABA's own timezone, used to
--      bucket messages into a billing month. Nothing in this codebase
--      stored a WABA timezone before this (see the cost-dashboard
--      audit); every dashboard/date helper up to now bucketed in the
--      SERVER's local time, which is wrong for "this month" billing
--      once the server and the business are in different zones.
--
--   2. rate_card — Meta's per-category, per-market conversation rate,
--      versioned by `effective_from` so a rate change doesn't rewrite
--      history. Seeded with UAE rates below.
--
--   3. message_billing — one row per (phone_number_id, message_id,
--      category) billing event, written exclusively by
--      record_message_billing() (migration 052). `message_id` is NOT
--      globally unique — Meta's wamids repeat across phone numbers,
--      per the comment at migration 009 and the cost-dashboard audit
--      — so the natural key here is the full triple, not message_id
--      alone.
--
-- Deliberately NOT constrained by a CHECK on `category` /
-- `pricing_type` / `pricing_model`: the real payload captured against
-- a live number (2026-09) came back as
--   { "type": "free_customer_service", "billable": false,
--     "category": "service", "pricing_model": "PMP" }
-- and Meta is known to change this vocabulary on 1 October 2026 (the
-- `type` field's pre-October value is already flagged as provisional).
-- A rigid CHECK here would risk rejecting inserts the moment that
-- change lands. Store what Meta sends, verbatim.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- 1. whatsapp_config.timezone
-- ============================================================
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'Asia/Dubai';

-- ============================================================
-- 2. rate_card
--
-- `market` + `category` + `effective_from` is the natural key —
-- ON CONFLICT DO NOTHING on the seed insert below relies on it so
-- re-running this migration doesn't duplicate rows.
--
-- NOTE: record_message_billing() (052) currently hardcodes
-- market = 'UAE' when looking up a rate, because no per-account /
-- per-WABA market field exists anywhere in this schema yet (see the
-- cost-dashboard audit — "not found"). Adding a second market means
-- either a market column on whatsapp_config or passing market
-- explicitly into that function; until then, rows for any other
-- market are inert.
-- ============================================================
CREATE TABLE IF NOT EXISTS rate_card (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market         TEXT NOT NULL,
  category       TEXT NOT NULL,
  rate_usd       NUMERIC(10,6) NOT NULL,
  effective_from DATE NOT NULL,
  UNIQUE (market, category, effective_from)
);

-- Seed: UAE rates.
--
-- The 2026-10-01 rows (0.0157 service/utility/authentication, 0.0499
-- marketing) come from a vendor blog post, NOT Meta's own pricing
-- page — flagged explicitly by whoever captured them. Verify against
-- https://developers.facebook.com/docs/whatsapp/pricing (or the
-- current equivalent) before the dashboard shows a client a real
-- number. Each rate is a single row — correcting it later is a
-- one-line UPDATE, not a migration.
--
-- The 2026-01-01 rows at rate 0 exist so any message sent before
-- 1 October 2026 prices at zero rather than retroactively applying
-- the October rate — record_message_billing() picks the newest
-- effective_from that is <= the message's own billing month.
INSERT INTO rate_card (market, category, rate_usd, effective_from) VALUES
  ('UAE', 'service',        0,      '2026-01-01'),
  ('UAE', 'utility',        0,      '2026-01-01'),
  ('UAE', 'marketing',      0,      '2026-01-01'),
  ('UAE', 'authentication', 0,      '2026-01-01'),
  ('UAE', 'service',        0.0157, '2026-10-01'),
  ('UAE', 'utility',        0.0157, '2026-10-01'),
  ('UAE', 'marketing',      0.0499, '2026-10-01'),
  ('UAE', 'authentication', 0.0157, '2026-10-01')
ON CONFLICT (market, category, effective_from) DO NOTHING;

-- Global reference data, not per-account — is_account_member() doesn't
-- apply (no account_id column). Readable by any signed-in user (the
-- rate list carries no per-account financial data, just the price
-- list); never exposed to anon.
ALTER TABLE rate_card ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rate_card_select ON rate_card;
CREATE POLICY rate_card_select ON rate_card FOR SELECT
  USING (auth.uid() IS NOT NULL);
-- No INSERT/UPDATE/DELETE policy for `authenticated` — rates are
-- maintained by whoever operates this deployment, directly in the DB.

-- ============================================================
-- 3. message_billing
--
-- One row per billed (or free/non-billable) message event. Written
-- exclusively by record_message_billing() (052); no direct
-- client-side writes.
--
-- UNIQUE (phone_number_id, message_id, category) rather than a
-- unique message_id: message_id is not unique across numbers (009),
-- and in principle Meta could (rarely) report more than one category
-- for related events on the same message — the triple is the real
-- idempotency key for "did we already bill this".
-- ============================================================
CREATE TABLE IF NOT EXISTS message_billing (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  phone_number_id TEXT NOT NULL,
  message_id      TEXT NOT NULL,
  -- Meta's `pricing.type` — pre-October vocabulary (e.g.
  -- 'free_customer_service'); changes 1 October 2026. Stored verbatim.
  pricing_type    TEXT NOT NULL,
  -- Meta's `pricing.category` (e.g. 'service', 'marketing').
  category        TEXT NOT NULL,
  -- Meta's `pricing.billable`. false ⇒ cost_usd is always 0,
  -- regardless of rate or free-tier state.
  billable        BOOLEAN NOT NULL,
  -- Meta's `pricing.pricing_model` (e.g. 'PMP', 'CBP').
  pricing_model   TEXT NOT NULL,
  -- The rate_card rate that applied at send time, whether or not this
  -- message actually cost anything (billable=false / free tier both
  -- leave this populated with the would-be rate for transparency).
  rate_usd        NUMERIC(10,6) NOT NULL DEFAULT 0,
  -- What was actually billed: 0 when billable=false, 0 while the
  -- monthly free tier covers this message, rate_usd otherwise.
  cost_usd        NUMERIC(10,6) NOT NULL DEFAULT 0,
  -- Computed from `sent_at` in the WABA's OWN timezone
  -- (whatsapp_config.timezone), not server time — see
  -- record_message_billing() (052).
  billing_month   DATE NOT NULL,
  sent_at         TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (phone_number_id, message_id, category)
);

-- Account-scoped, newest-first / month-bucketed reads — the only
-- access pattern (a cost dashboard: "this account, this month").
CREATE INDEX IF NOT EXISTS idx_message_billing_account_month
  ON message_billing(account_id, billing_month);

ALTER TABLE message_billing ENABLE ROW LEVEL SECURITY;

-- Same shape as ai_usage_log_select (033): admin+ only (spend is
-- billing-class), no write policy for `authenticated` — writes come
-- exclusively from record_message_billing(), a SECURITY DEFINER
-- function invoked by the service-role webhook path.
DROP POLICY IF EXISTS message_billing_select ON message_billing;
CREATE POLICY message_billing_select ON message_billing FOR SELECT
  USING (is_account_member(account_id, 'admin'));
