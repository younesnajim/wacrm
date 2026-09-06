import type { ChatMessage } from './types'

/** Longest the quoted customer message runs before we ellipsize it —
 *  keeps the stored snippet a glanceable one-liner. */
const MAX_QUOTE_LEN = 160

/**
 * Facts about a handoff, for `AiThreadBanner` to format through the
 * message catalogue at render time — not a pre-formatted sentence.
 *
 * This used to return an assembled English sentence
 * ("🤖 AI agent handed off after 2 replies. Last customer message:
 * …"), stored verbatim in `conversations.ai_handoff_summary` and
 * rendered as-is in an otherwise fully-localized banner. That doesn't
 * work: this runs from the WhatsApp webhook's `after()` callback, with
 * no browser request/session/cookie in scope, and this app's only
 * notion of "locale" IS a per-browser cookie (src/i18n/locale.ts) —
 * there's no account/user-level language to correctly localize into
 * even in principle at write time. See migration 049.
 *
 * `lastMessage` is the customer's own words, not UI copy — it needs no
 * translation, only to be stored separately from the sentence that
 * used to wrap it.
 */
export interface HandoffFields {
  /** The bot's auto-reply tally for the thread (0 when it bailed on
   *  the very first inbound without answering). */
  replyCount: number
  /** Truncated/whitespace-collapsed quote of the most recent customer
   *  turn, or null when there isn't one to quote. */
  lastMessage: string | null
}

export function buildHandoffFields(args: {
  messages: ChatMessage[]
  replyCount: number
}): HandoffFields {
  const { messages, replyCount } = args

  const lastCustomer = [...messages]
    .reverse()
    .find((m) => m.role === 'user' && m.content.trim())

  return {
    replyCount,
    lastMessage: lastCustomer
      ? truncate(lastCustomer.content.trim(), MAX_QUOTE_LEN)
      : null,
  }
}

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ')
  if (collapsed.length <= max) return collapsed
  return `${collapsed.slice(0, max - 1).trimEnd()}…`
}
