-- ============================================================
-- 050_webhook_raw_log.sql — temporary raw capture of inbound WhatsApp
-- webhook deliveries.
--
-- Purpose: Meta's webhook `statuses[]` entries reportedly carry a
-- `pricing` object, but nothing in this codebase has ever parsed or
-- logged one — see the cost-dashboard audit. Before wiring up real
-- billing (migration 051+), we need to see the actual payload shape
-- from a live number. This table is the capture point: the webhook
-- route (gated by WEBHOOK_RAW_LOG=1) writes the full, unparsed
-- request body here so it can be inspected later.
--
-- This is deliberately temporary infrastructure, not a permanent
-- audit log — no retention policy, no rollup, no RLS read access for
-- anyone. Drop it once the real pricing shape has been captured and
-- migration 051 lands.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS webhook_raw_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  body        JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Service-role only. No SELECT/INSERT/UPDATE/DELETE policy for
-- `authenticated` — the webhook route writes via the service-role
-- client (which bypasses RLS), and no client surface ever reads this
-- table. RLS is still enabled so a future policy-less client role
-- can't accidentally see raw payloads.
ALTER TABLE webhook_raw_log ENABLE ROW LEVEL SECURITY;
