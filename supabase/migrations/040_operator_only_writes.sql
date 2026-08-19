-- ============================================================
-- 040_operator_only_writes.sql — owner-only writes for
-- automations, flows, and the AI agent config.
--
-- Context
--   The dashboard UI now hides Automations, Flows, and AI Agents
--   from anyone below `owner` (sidebar nav filtered, each route
--   segment gated with RequireRole, the "New Automation" dashboard
--   shortcut hidden). Until this migration, the database itself
--   still let `agent`+ (automations/flows) or `admin`+ (ai_configs)
--   write to these tables directly — a client teammate calling the
--   API by hand, or a future code path that forgets the UI gate,
--   would have gone straight through. This migration closes that
--   gap so the database enforces the same boundary the UI shows.
--
-- Read access is intentionally UNCHANGED:
--   - `automations_select` / `flows_select` / `automation_steps_select`
--     / `flow_nodes_select` / `automation_logs_select` /
--     `flow_runs_select` stay at `is_account_member(account_id)`
--     (viewer+). Nothing client-facing currently depends on reading
--     these — the builder/list pages are the only readers, and
--     they're already owner-gated in the UI — but there's no reason
--     to tighten a read path nobody asked to restrict.
--   - `ai_configs_select` stays at viewer+ **on purpose** — the inbox's
--     "Draft with AI" affordance and GET /api/ai/config read this
--     table for every account member (see 029_ai_reply.sql's own
--     comment: "any member of the account (viewer+) may read the
--     config"). Restricting this SELECT would break that affordance
--     for every non-owner. Only INSERT/UPDATE/DELETE move to owner+.
--
-- Idempotent — DROP POLICY IF EXISTS before every CREATE, safe to
-- re-run.
-- ============================================================

-- ---- automations -------------------------------------------------
DROP POLICY IF EXISTS automations_insert ON automations;
CREATE POLICY automations_insert ON automations FOR INSERT
  WITH CHECK (is_account_member(account_id, 'owner'));

DROP POLICY IF EXISTS automations_update ON automations;
CREATE POLICY automations_update ON automations FOR UPDATE
  USING (is_account_member(account_id, 'owner'));

DROP POLICY IF EXISTS automations_delete ON automations;
CREATE POLICY automations_delete ON automations FOR DELETE
  USING (is_account_member(account_id, 'owner'));

-- ---- automation_steps ---------------------------------------------
-- `FOR ALL` also covers SELECT, but `automation_steps_select` (FOR
-- SELECT, viewer+) is a separate permissive policy — Postgres ORs
-- policies for the same command, so read access stays viewer+ even
-- though this one now requires owner.
DROP POLICY IF EXISTS automation_steps_modify ON automation_steps;
CREATE POLICY automation_steps_modify ON automation_steps FOR ALL USING (
  EXISTS (SELECT 1 FROM automations a WHERE a.id = automation_steps.automation_id AND is_account_member(a.account_id, 'owner'))
) WITH CHECK (
  EXISTS (SELECT 1 FROM automations a WHERE a.id = automation_steps.automation_id AND is_account_member(a.account_id, 'owner'))
);

-- ---- flows ----------------------------------------------------------
DROP POLICY IF EXISTS flows_insert ON flows;
CREATE POLICY flows_insert ON flows FOR INSERT
  WITH CHECK (is_account_member(account_id, 'owner'));

DROP POLICY IF EXISTS flows_update ON flows;
CREATE POLICY flows_update ON flows FOR UPDATE
  USING (is_account_member(account_id, 'owner'));

DROP POLICY IF EXISTS flows_delete ON flows;
CREATE POLICY flows_delete ON flows FOR DELETE
  USING (is_account_member(account_id, 'owner'));

-- ---- flow_nodes -------------------------------------------------
-- Same FOR ALL / separate-SELECT-policy reasoning as automation_steps.
DROP POLICY IF EXISTS flow_nodes_modify ON flow_nodes;
CREATE POLICY flow_nodes_modify ON flow_nodes FOR ALL USING (
  EXISTS (SELECT 1 FROM flows f WHERE f.id = flow_nodes.flow_id AND is_account_member(f.account_id, 'owner'))
) WITH CHECK (
  EXISTS (SELECT 1 FROM flows f WHERE f.id = flow_nodes.flow_id AND is_account_member(f.account_id, 'owner'))
);

-- ---- ai_configs -----------------------------------------------------
-- Was admin+ (029_ai_reply.sql); tightened to owner+ to match the UI.
-- ai_configs_select is untouched — see header comment.
DROP POLICY IF EXISTS ai_configs_insert ON ai_configs;
CREATE POLICY ai_configs_insert ON ai_configs FOR INSERT
  WITH CHECK (is_account_member(account_id, 'owner'));

DROP POLICY IF EXISTS ai_configs_update ON ai_configs;
CREATE POLICY ai_configs_update ON ai_configs FOR UPDATE
  USING (is_account_member(account_id, 'owner'));

DROP POLICY IF EXISTS ai_configs_delete ON ai_configs;
CREATE POLICY ai_configs_delete ON ai_configs FOR DELETE
  USING (is_account_member(account_id, 'owner'));
