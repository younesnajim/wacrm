-- ============================================================
-- 048_ai_session_reset.sql — reset AI auto-reply state on a new
-- WhatsApp session (issue: reply cap is silent + permanent)
--
-- The problem
--
--   `conversations.ai_reply_count` only ever resets via the manual
--   "Resume AI" button (POST /api/ai/autoreply/[id] with paused:
--   false). Once a chatty thread hits `auto_reply_max_per_conversation`,
--   the bot stays quiet on that conversation forever — including for a
--   returning customer weeks later starting what is, for WhatsApp
--   session-window purposes, an entirely new conversation. Same story
--   for `ai_autoreply_disabled`: once the model hands off (or a human
--   takes over and never explicitly resumes), it stays sticky across
--   any number of future customer sessions.
--
-- The fix
--
--   `reset_ai_session_if_stale(conversation_id, current_message_at)`,
--   called from the webhook right after a new inbound customer message
--   is inserted (and before AI dispatch). It finds that conversation's
--   customer message immediately BEFORE the one just inserted and, if
--   the gap is >= 24h, resets both `ai_reply_count` (0) and
--   `ai_autoreply_disabled` (false) in the same statement — read and
--   write atomic, same shape as `claim_ai_reply_slot` (029), so two
--   concurrent inbound deliveries can't interleave a stale read with a
--   fresh write.
--
--   Deliberately keyed on the CUSTOMER message timeline, not
--   `conversations.last_message_at`: that column is bumped by outbound
--   sends too (send-message.ts, flows/meta-send.ts, automations/
--   meta-send.ts), so an agent or bot reply keeps it fresh even while
--   the customer has gone quiet for weeks — using it here would mask
--   exactly the gap we need to detect. `messages.sender_type =
--   'customer'` is the ground truth already used for the same purpose
--   client-side (message-thread.tsx's 24h session timer) and for
--   `isFirstInboundMessage` in the webhook.
--
--   No reset on conversation close/reopen — those touch `status` only
--   (close_conversation automation step, reopenClosedConversation) and
--   are intentionally left alone; this is a session-boundary reset,
--   not a status-boundary one.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- Supports the function's "find the customer message right before this
-- one" lookup without scanning every message in a long-lived thread.
-- Partial: only customer messages are ever queried this way.
CREATE INDEX IF NOT EXISTS idx_messages_conversation_customer_created
  ON messages(conversation_id, created_at DESC)
  WHERE sender_type = 'customer';

CREATE OR REPLACE FUNCTION public.reset_ai_session_if_stale(
  conversation_id uuid,
  current_message_at timestamptz
)
RETURNS boolean AS $$
  WITH prior_customer_message AS (
    SELECT created_at
    FROM messages
    WHERE messages.conversation_id = reset_ai_session_if_stale.conversation_id
      AND sender_type = 'customer'
      AND created_at < current_message_at
    ORDER BY created_at DESC
    LIMIT 1
  ),
  reset AS (
    UPDATE conversations
    SET ai_reply_count = 0,
        ai_autoreply_disabled = false
    WHERE id = reset_ai_session_if_stale.conversation_id
      AND EXISTS (
        SELECT 1 FROM prior_customer_message
        WHERE prior_customer_message.created_at <= current_message_at - INTERVAL '24 hours'
      )
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM reset);
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;

-- Only the service role (webhook) calls this — same grant pattern as
-- `claim_ai_reply_slot` (029/031) and `bump_conversation_on_inbound`
-- (037). Explicit here rather than a follow-up migration: 031 exists
-- because 029 forgot this exact grant and the bot silently never fired
-- on hardened Postgres instances (issue #345) — not repeating that.
REVOKE ALL ON FUNCTION public.reset_ai_session_if_stale(uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reset_ai_session_if_stale(uuid, timestamptz) FROM anon;
REVOKE ALL ON FUNCTION public.reset_ai_session_if_stale(uuid, timestamptz) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.reset_ai_session_if_stale(uuid, timestamptz) TO service_role;
