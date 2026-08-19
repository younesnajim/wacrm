-- ============================================================
-- 046_pass2_permissions.sql — raise two write thresholds per the
-- permission-pass audit:
--
--   1. Deleting a deal is admin+, not agent+. Deal creation/edit/
--      move stays agent+ (standard CRM: reps work deals, only a
--      manager-tier role removes one outright).
--   2. Broadcasts are admin+ across the board (select/insert/
--      update/delete), not agent+. An agent sending a bad broadcast
--      to thousands of contacts is a Meta quality-rating incident
--      that can get a client's WhatsApp number restricted — this
--      is a business-risk gate, not a data-sensitivity one, which
--      is why even SELECT is raised (agents shouldn't see the
--      broadcast surface at all).
--
-- Contacts and conversations already had the right thresholds from
-- 017_account_sharing.sql (select: all members, write: agent+) —
-- no change needed there.
--
-- Idempotent — DROP POLICY IF EXISTS + CREATE throughout.
-- ============================================================

DROP POLICY IF EXISTS deals_delete ON deals;
CREATE POLICY deals_delete ON deals FOR DELETE USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS broadcasts_select ON broadcasts;
CREATE POLICY broadcasts_select ON broadcasts FOR SELECT USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS broadcasts_insert ON broadcasts;
CREATE POLICY broadcasts_insert ON broadcasts FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS broadcasts_update ON broadcasts;
CREATE POLICY broadcasts_update ON broadcasts FOR UPDATE USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS broadcasts_delete ON broadcasts;
CREATE POLICY broadcasts_delete ON broadcasts FOR DELETE USING (is_account_member(account_id, 'admin'));

-- broadcast_recipients has its own independent is_account_member()
-- checks (017_account_sharing.sql) rather than inheriting from the
-- broadcasts row policies — raise both the same way so an agent
-- can't read/write recipient rows for a broadcast they can no
-- longer see.
DROP POLICY IF EXISTS broadcast_recipients_select ON broadcast_recipients;
CREATE POLICY broadcast_recipients_select ON broadcast_recipients FOR SELECT USING (
  EXISTS (SELECT 1 FROM broadcasts b WHERE b.id = broadcast_recipients.broadcast_id AND is_account_member(b.account_id, 'admin'))
);

DROP POLICY IF EXISTS broadcast_recipients_modify ON broadcast_recipients;
CREATE POLICY broadcast_recipients_modify ON broadcast_recipients FOR ALL USING (
  EXISTS (SELECT 1 FROM broadcasts b WHERE b.id = broadcast_recipients.broadcast_id AND is_account_member(b.account_id, 'admin'))
) WITH CHECK (
  EXISTS (SELECT 1 FROM broadcasts b WHERE b.id = broadcast_recipients.broadcast_id AND is_account_member(b.account_id, 'admin'))
);
