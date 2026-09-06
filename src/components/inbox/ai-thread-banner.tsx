"use client";

import { useState, useEffect, useCallback } from "react";
import { Sparkles, Hand, Undo2, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { useAuth } from "@/hooks/use-auth";
import { getAutoReplyStatus } from "@/lib/ai/eligibility";

// ------------------------------------------------------------
// Account AI status is the same for every conversation, so cache it per
// account and reuse it across thread switches instead of hitting
// /api/ai/config every time the agent opens a chat.
//
// Keyed by accountId (a multi-account user switching workspaces must not
// see the previous account's status), and only *successful* fetches are
// cached — a transient failure returns a default without poisoning the
// cache, so it retries on the next thread open rather than hiding the
// banner for the whole session.
// ------------------------------------------------------------
interface AiAccountStatus {
  autoReplyOn: boolean;
  /** `ai_configs.auto_reply_max_per_conversation` — irrelevant (and left
   *  at a harmless default) whenever `autoReplyOn` is false. */
  maxPerConversation: number;
}
const statusCache = new Map<string, AiAccountStatus>();

async function fetchAiAccountStatus(accountId: string): Promise<AiAccountStatus> {
  const cached = statusCache.get(accountId);
  if (cached) return cached;
  try {
    const res = await fetch("/api/ai/config", { cache: "no-store" });
    if (!res.ok) return { autoReplyOn: false, maxPerConversation: Infinity }; // don't cache a transient failure
    const j = await res.json();
    const status = {
      // AI auto-reply is "live" only when configured, the master switch
      // is on, and the inbound bot is enabled.
      autoReplyOn: !!(j?.configured && j?.is_active && j?.auto_reply_enabled),
      maxPerConversation: Number(j?.auto_reply_max_per_conversation) || Infinity,
    };
    statusCache.set(accountId, status);
    return status;
  } catch {
    return { autoReplyOn: false, maxPerConversation: Infinity }; // don't cache
  }
}

interface AiThreadBannerProps {
  conversationId: string;
  /** `conversations.ai_autoreply_disabled` — bot paused on this thread. */
  disabled: boolean;
  /** `conversations.ai_handoff_reply_count` / `ai_handoff_last_message`
   *  (migration 049) — structured handoff facts, formatted through the
   *  message catalogue below so the note renders correctly regardless
   *  of the viewer's locale. Preferred over `handoffSummary` whenever
   *  present. */
  handoffReplyCount?: number | null;
  handoffLastMessage?: string | null;
  /** `conversations.ai_handoff_summary` — legacy pre-formatted English
   *  note (migration 029/033). Only rendered as a fallback, for a
   *  handoff written before migration 049 whose structured fields are
   *  null — see src/lib/ai/handoff.ts for why it was replaced. */
  handoffSummary?: string | null;
  /** `conversations.ai_reply_count` — how many times the bot has
   *  auto-replied on this thread, checked against the account's
   *  configured max to detect a silently-reached cap. */
  replyCount?: number;
  /** Current assignee; when a human owns the thread the bot won't run,
   *  so the "AI active" banner is suppressed. */
  assignedAgentId?: string | null;
  /** The acting agent — "Take over" assigns the thread to them. */
  currentUserId?: string | null;
  /** Called after a successful toggle so the parent can patch its local
   *  conversation state (the realtime UPDATE also arrives, but this keeps
   *  the banner instant). */
  onChange?: (patch: {
    ai_autoreply_disabled: boolean;
    assigned_agent_id?: string | null;
  }) => void;
}

/**
 * Inbox banner that surfaces + controls the AI auto-reply bot per
 * conversation:
 *   - bot active here → "AI is replying automatically" + [Take over]
 *   - bot paused here → the handoff note (if any) + [Resume AI]
 * Renders nothing when the account has no auto-reply configured, or when
 * the bot is active but a human already owns the thread (nothing to do).
 */
export function AiThreadBanner({
  conversationId,
  disabled,
  handoffReplyCount,
  handoffLastMessage,
  handoffSummary,
  replyCount,
  assignedAgentId,
  currentUserId,
  onChange,
}: AiThreadBannerProps) {
  const t = useTranslations("Inbox.aiBanner");
  const { accountId } = useAuth();
  const [accountStatus, setAccountStatus] = useState<AiAccountStatus | null>(null);
  const [busy, setBusy] = useState(false);
  // Optimistic local mirror of the pause flag so the banner flips
  // instantly on click; re-seeds whenever the thread (or its server
  // state via realtime) changes.
  const [paused, setPaused] = useState(disabled);
  useEffect(() => setPaused(disabled), [conversationId, disabled]);

  useEffect(() => {
    if (!accountId) return;
    let alive = true;
    fetchAiAccountStatus(accountId).then((s) => alive && setAccountStatus(s));
    return () => {
      alive = false;
    };
  }, [accountId]);

  const toggle = useCallback(
    async (paused: boolean) => {
      setBusy(true);
      try {
        const res = await fetch(`/api/ai/autoreply/${conversationId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // "Take over" also assigns the thread to the acting agent.
          body: JSON.stringify({ paused, assign_to_me: paused }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          toast.error(j?.error ?? t("updateError"));
          return;
        }
        setPaused(paused);
        onChange?.({
          ai_autoreply_disabled: paused,
          // Take over assigns to the acting agent; resume releases only
          // the caller's own assignment. The realtime UPDATE reconciles
          // the exact value either way.
          ...(paused
            ? currentUserId
              ? { assigned_agent_id: currentUserId }
              : {}
            : { assigned_agent_id: null }),
        });
        toast.success(paused ? t("tookOver") : t("resumed"));
      } catch {
        toast.error(t("networkError"));
      } finally {
        setBusy(false);
      }
    },
    [conversationId, currentUserId, onChange, t],
  );

  // Still loading account status → nothing yet.
  if (!accountStatus) return null;

  // Single source of truth, shared with the server-side send gate
  // (dispatchInboundToAiReply) — see src/lib/ai/eligibility.ts. This is
  // what keeps this banner from claiming the bot is active when the cap
  // has silently been reached.
  const status = getAutoReplyStatus({
    autoReplyEnabledForAccount: accountStatus.autoReplyOn,
    assignedAgentId,
    autoreplyDisabledOnConversation: paused,
    replyCount: replyCount ?? 0,
    maxRepliesPerConversation: accountStatus.maxPerConversation,
  });

  // Account has no auto-reply, or a human already owns this thread and
  // was never routed here via "Take over" → nothing to show.
  if (status === "off" || status === "human_assigned") return null;

  // Paused (model handoff, or a manual pause) or capped out — both mean
  // the bot won't reply until an agent explicitly resumes it.
  if (status === "paused" || status === "capped") {
    // Structured fields (migration 049) take priority — they format
    // through the catalogue below with correct plural rules for the
    // viewer's own locale. `handoffReplyCount` is only ever set when the
    // bot itself produced this pause (a handoff); a manual "Take over"
    // has no note at all, structured or legacy. Falls back to the
    // legacy pre-formatted string for a handoff written before this
    // migration shipped.
    const handoffNote =
      status === "paused" && handoffReplyCount != null
        ? [
            t("handoffNote", { count: handoffReplyCount }),
            handoffLastMessage
              ? t("handoffLastMessage", { message: handoffLastMessage })
              : null,
          ]
            .filter(Boolean)
            .join(" ")
        : status === "paused"
          ? (handoffSummary ?? null)
          : null;

    return (
      <Banner tone="muted">
        <div className="min-w-0 flex-1">
          <p className="font-medium text-foreground">
            {status === "capped" ? t("cappedTitle") : t("pausedTitle")}
          </p>
          {handoffNote && (
            <p className="truncate text-muted-foreground" title={handoffNote}>
              {handoffNote}
            </p>
          )}
        </div>
        <BannerButton onClick={() => toggle(false)} busy={busy} icon={Undo2}>
          {t("resume")}
        </BannerButton>
      </Banner>
    );
  }

  // Active on this thread.
  return (
    <Banner tone="primary">
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <Sparkles className="h-3.5 w-3.5 flex-shrink-0 text-primary" />
        <span className="truncate font-medium text-foreground">
          {t("activeText")}
        </span>
      </div>
      <BannerButton onClick={() => toggle(true)} busy={busy} icon={Hand}>
        {t("takeOver")}
      </BannerButton>
    </Banner>
  );
}

function Banner({
  tone,
  children,
}: {
  tone: "primary" | "muted";
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 border-b px-3 py-2 text-xs sm:px-4",
        tone === "primary"
          ? "border-primary/20 bg-primary/5"
          : "border-border bg-muted/40",
      )}
    >
      {children}
    </div>
  );
}

function BannerButton({
  onClick,
  busy,
  icon: Icon,
  children,
}: {
  onClick: () => void;
  busy: boolean;
  icon: typeof Hand;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="inline-flex flex-shrink-0 items-center gap-1 rounded-md border border-border bg-card px-2.5 py-1 font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-60"
    >
      {busy ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <Icon className="h-3 w-3" />
      )}
      {children}
    </button>
  );
}
