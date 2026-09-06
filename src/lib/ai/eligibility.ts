// ============================================================
// Single source of truth for "is the auto-reply bot live on this
// conversation right now" — the server-side send gate
// (`dispatchInboundToAiReply`) and the inbox's `AiThreadBanner` used to
// each hand-roll this as a slightly different set of conditions, which
// is how the reply-cap check ended up in the gate but not the banner:
// the banner kept claiming "AI is replying automatically" long after
// the bot had silently gone quiet. Both now call `getAutoReplyStatus`
// so there is exactly one place this logic can drift.
//
// Deliberately dependency-free (no supabase / server-only imports) so
// it's safe to import from a "use client" component as well as from
// server code — same as `./types`.
// ============================================================

export type AutoReplyStatus =
  | 'off' // account: not configured / master switch off / auto-reply disabled
  | 'human_assigned' // a human owns this thread
  | 'paused' // ai_autoreply_disabled — model handoff or a manual pause
  | 'capped' // ai_reply_count has reached the configured max
  | 'active' // the bot will answer the next eligible inbound

export interface AutoReplyStatusInput {
  /** Account-level: config exists, master switch on, auto-reply enabled. */
  autoReplyEnabledForAccount: boolean
  /** `conversations.assigned_agent_id`. */
  assignedAgentId: string | null | undefined
  /** `conversations.ai_autoreply_disabled`. */
  autoreplyDisabledOnConversation: boolean
  /** `conversations.ai_reply_count`. */
  replyCount: number
  /** `ai_configs.auto_reply_max_per_conversation`. */
  maxRepliesPerConversation: number
}

/**
 * Order matches `dispatchInboundToAiReply`'s eligibility gates exactly:
 * account switch, then human ownership, then the per-conversation
 * pause, then the reply cap.
 */
export function getAutoReplyStatus(
  input: AutoReplyStatusInput,
): AutoReplyStatus {
  if (!input.autoReplyEnabledForAccount) return 'off'
  if (input.assignedAgentId) return 'human_assigned'
  if (input.autoreplyDisabledOnConversation) return 'paused'
  if (input.replyCount >= input.maxRepliesPerConversation) return 'capped'
  return 'active'
}
