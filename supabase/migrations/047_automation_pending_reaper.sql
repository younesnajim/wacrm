-- ============================================================
-- 047_automation_pending_reaper.sql — recover automation `wait` steps
-- orphaned by a crash mid-resume
--
-- The problem
--
--   `GET /api/automations/cron` claims a due automation_pending_
--   executions row with `UPDATE ... SET status='running' WHERE
--   status='pending'`, then calls resumePendingExecution(). If the
--   process dies between the claim and the row being marked 'done'
--   or 'failed' (container restart, OOM kill, deploy), the row is
--   stuck at status='running' forever — nothing ever resets it, and
--   the cron's due-row query only looks at status='pending'. The
--   parked automation silently never resumes.
--
-- The fix
--
--   Two columns the cron route uses to detect and recover a stuck
--   claim:
--     - claimed_at: stamped when a row moves pending -> running, so
--       "claimed but never finished" can be measured by age rather
--       than guessed from run_at (which reflects the original wait
--       delay, not when it was actually picked up).
--     - attempts: incremented on every claim (fresh or reclaimed), so
--       a row that crashes the process every single time it's resumed
--       doesn't retry forever — the cron gives up and marks it
--       'failed' past a small cap, the same terminal state a normal
--       execution failure already uses.
--
-- Idempotent — ADD COLUMN IF NOT EXISTS.
-- ============================================================

ALTER TABLE automation_pending_executions
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;

-- Sweep target: stale 'running' rows, oldest first. Partial index
-- mirrors idx_automation_pending_due's shape for the 'pending' side.
CREATE INDEX IF NOT EXISTS idx_automation_pending_stale_running
  ON automation_pending_executions(claimed_at) WHERE status = 'running';
