// ============================================================
// DELETE /api/account/invitations/[id]
//
// Admin+, AND the invite's role must be strictly below the caller's
// own — an admin revoking (or, before 045/046, creating) an
// Admin-level invite is the same peer-escalation shape as
// set_member_role/remove_account_member: it would let an admin
// manage another invite that could mint a peer. RLS on
// `account_invitations` (`is_account_member(account_id, 'admin')`)
// still scopes the row to admins of the inviting account; the rank
// check on top of that is enforced here, not in RLS — there's no
// SECURITY DEFINER RPC for invites the way there is for members.
//
// We intentionally delete the row outright rather than soft-
// deleting (a "revoked_at" flag). Once revoked, an invite is
// dead forever — there's no UX where a former invite should be
// listed; the plaintext token is gone too. Hard delete keeps
// the table small.
// ============================================================

import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { isAccountRole, roleRank } from "@/lib/auth/roles";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole("admin");

    const limit = checkRateLimit(
      `admin:inviteRevoke:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;

    // Read the invite's role first — RLS-scoped, so a cross-account
    // id returns no row here too (same "don't leak existence"
    // property the old single-DELETE approach had). No
    // `eq('account_id', ctx.accountId)` needed for the same reason
    // as the DELETE below.
    const { data: invite, error: fetchErr } = await ctx.supabase
      .from("account_invitations")
      .select("role")
      .eq("id", id)
      .maybeSingle();

    if (fetchErr) {
      console.error("[DELETE /api/account/invitations/[id]] fetch error:", fetchErr);
      return NextResponse.json(
        { error: "Failed to revoke invitation" },
        { status: 500 },
      );
    }
    if (!invite) {
      return NextResponse.json(
        { error: "Invitation not found" },
        { status: 404 },
      );
    }

    // Peer-escalation guard: an admin revoking (== full control over)
    // an Admin-level invite is the same hole as creating one. Fails
    // safe if the role is somehow outside the known enum — treat an
    // unrecognized role as un-revokable by anyone but a higher tier
    // isn't well-defined, so 500 rather than silently allowing it.
    if (!isAccountRole(invite.role)) {
      console.error(
        "[DELETE /api/account/invitations/[id]] unknown invite role:",
        invite.role,
      );
      return NextResponse.json(
        { error: "Failed to revoke invitation" },
        { status: 500 },
      );
    }
    if (roleRank(invite.role) >= roleRank(ctx.role)) {
      return NextResponse.json(
        { error: "You can only revoke invitations for a role below your own" },
        { status: 403 },
      );
    }

    // No `eq('account_id', ctx.accountId)` — the RLS policy
    // (`is_account_member(account_id, 'admin')`) already scopes
    // the DELETE to invites in the caller's account. Adding the
    // filter would be redundant; omitting it surfaces a
    // cross-account attempt as a silent 0-row delete (which is
    // exactly what we want for a revocation endpoint).
    const { error, count } = await ctx.supabase
      .from("account_invitations")
      .delete({ count: "exact" })
      .eq("id", id);

    if (error) {
      console.error("[DELETE /api/account/invitations/[id]] error:", error);
      return NextResponse.json(
        { error: "Failed to revoke invitation" },
        { status: 500 },
      );
    }

    if (count === 0) {
      // Either the id doesn't exist or RLS hid it (different
      // account) — or it was revoked/redeemed between our fetch
      // above and this delete. 404 either way — surfacing "exists
      // but not yours" would leak existence.
      return NextResponse.json(
        { error: "Invitation not found" },
        { status: 404 },
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
