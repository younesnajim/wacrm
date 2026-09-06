-- ============================================================
-- 049_ai_handoff_structured.sql — structured AI handoff fields
--
-- The problem
--
--   `conversations.ai_handoff_summary` (029/033) is a single English
--   prose sentence assembled server-side ("🤖 AI agent handed off
--   after 2 replies. Last customer message: …") and rendered verbatim
--   in `AiThreadBanner`, which is otherwise fully localized via
--   next-intl. It's written from the WhatsApp webhook's `after()`
--   callback — no incoming browser request, no session, no cookie —
--   and this app's only notion of "locale" is a per-browser cookie
--   (src/i18n/locale.ts), not a stored account/user attribute. There
--   is therefore no language to correctly bake the sentence into at
--   write time even in principle: two agents on the same account with
--   different locale cookies would need two different sentences from
--   the same stored value.
--
-- The fix
--
--   Store the FACTS instead of a pre-formatted sentence:
--     - `ai_handoff_reply_count` — the bot's reply tally at handoff.
--     - `ai_handoff_last_message` — the truncated/whitespace-collapsed
--       quote of the last customer message. This is the customer's own
--       words, not UI copy, so it needs no translation — only moving
--       out of the composed sentence into its own column.
--   `AiThreadBanner` formats these through the message catalogue at
--   render time (ICU plural rules), same as every other string in that
--   banner, so it renders correctly for whichever viewer has it open
--   regardless of their locale cookie.
--
--   `ai_handoff_summary` is kept, NOT backfilled, and NOT written by
--   new handoffs going forward — see the column comment. A handoff
--   still in progress from before this migration falls back to
--   rendering that frozen English string until it's resumed or closed;
--   there is no reliable way to reconstruct the reply count a past,
--   possibly-since-reset handoff had at the moment it happened, and a
--   dead conversation dropping out of view over time isn't worth a
--   backfill script for.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ai_handoff_reply_count integer;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ai_handoff_last_message text;

COMMENT ON COLUMN conversations.ai_handoff_summary IS
  'Legacy pre-formatted English handoff note (029/033). No longer '
  'written by new handoffs as of migration 049 — see '
  'ai_handoff_reply_count / ai_handoff_last_message, which the bot '
  'writes instead so the banner can render a localized sentence at '
  'view time. Left populated (and NOT backfilled) on rows written '
  'before this migration so an in-progress handoff does not lose its '
  'note; the UI falls back to rendering this verbatim only when the '
  'structured columns are null.';
