# WACRM Platform Architecture

Target state: one deployment, many client companies, roles that fit real
org charts, and AI/automation configuration held by the platform operator.

This document is the plan. Hand it to Claude Code as the brief, and have
it audit before writing code.

---

## Why this is worth doing now

Two kinds of change behave very differently on a live product.

**Additive features** — Instagram channel, booking, push notifications —
can land any time. They don't touch existing rows.

**Tenancy and role model** cannot. Once three companies have live
conversations, deals, and staff logins, changing who-can-see-what means
migrating production data across three deployments while people are using
them. That is the change you make before clients, not after.

Everything in this document is the second kind.

---

## The one thing that makes this cheap

`is_account_member(target_account_id, min_role)` in migration 017 is a
`SECURITY DEFINER` function, and **all 118 RLS policies across the schema
call it**. A grep for inline `account_id = (SELECT ...)` comparisons
returns zero.

So the entire authorization model has exactly one implementation point.
Rewrite that function and every policy in the database follows, unchanged.

This is the seam. Do not break it. Any new code must go through the same
function rather than adding its own account checks.

---

## Current model and its three limits

Today: `profiles.account_id` + `profiles.account_role`, with roles
`owner > admin > agent > viewer` and a DB constraint preventing more than
one owner per account.

**Limit 1 — a user belongs to exactly one account.** `account_id` is a
column on `profiles`, so there is no way to be a member of two accounts.
The platform operator therefore cannot hold one login across every client.

**Limit 2 — only four roles, and one is spoken for.** If the operator
takes `owner` to gate AI and automations, the client's business owner and
their managers both land on `admin` with identical power. In a company
with three managers, any manager can remove the business owner.

**Limit 3 — no teams.** Ten agents share one undifferentiated inbox with
no ownership boundary. Workable at ten, painful at twenty-five.

---

## Target model

### Two levels of authority, not one

The mistake to avoid is treating the platform operator as a super-admin
*inside* each account. That is what forces the role collision. Platform
authority is a separate axis.

```
PLATFORM
  platform_owner ....... you
  platform_admin ....... future hires, same operational access, no billing
  platform_billing ..... billing/subscription visibility only

ACCOUNT (one per client company)
  owner ................ the client's business owner
  admin ................ senior staff, full account management
  manager .............. runs a team, cannot touch admins
  agent ................ handles conversations
  viewer ............... read-only
```

The client's business owner gets `owner` of their own account. That is
correct — it is their business, their data, and it makes the relationship
honest. AI and automation configuration is gated on **platform role**,
not account role, so it stays with you regardless.

### Schema

```sql
-- Platform authority. Null for everyone except operator staff.
ALTER TABLE profiles
  ADD COLUMN platform_role platform_role_enum;   -- 'platform_owner' | 'platform_admin' | 'platform_billing' | null

-- Membership becomes many-to-many. This is the core change.
CREATE TABLE account_members (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role        account_role_enum NOT NULL,
  team_id     UUID REFERENCES teams(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, user_id)
);

CREATE TABLE teams (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, name)
);

-- Routing: which team owns a conversation. Nullable = unassigned.
ALTER TABLE conversations ADD COLUMN team_id UUID REFERENCES teams(id);
ALTER TABLE deals         ADD COLUMN team_id UUID REFERENCES teams(id);
```

Keep `profiles.account_id` as the *last active account* — it drives which
workspace loads on login. It stops being an authorization field.
`account_members` becomes the only source of truth for permissions.

### The rewritten function

```sql
CREATE OR REPLACE FUNCTION is_account_member(
  target_account_id UUID,
  min_role account_role_enum DEFAULT 'viewer'
) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT
    -- Platform staff reach every account at full authority.
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.user_id = auth.uid()
        AND p.platform_role IS NOT NULL
    )
    OR EXISTS (
      SELECT 1 FROM account_members m
      WHERE m.user_id = auth.uid()
        AND m.account_id = target_account_id
        AND role_rank(m.role) >= role_rank(min_role)
    );
$$;
```

Extract the rank CASE into its own `role_rank()` helper so adding a role
later is one edit rather than two parallel CASE blocks.

Add a second function for platform-only surfaces:

```sql
CREATE OR REPLACE FUNCTION is_platform_staff() RETURNS BOOLEAN ...
```

AI config, automations, and flows get RLS on `is_platform_staff()`.
Everything else keeps calling `is_account_member()` exactly as it does now.

---

## The three companies, mapped

| | Company A | Company B | Company C |
|---|---|---|---|
| Business owner | owner | owner | owner |
| Managers | manager ×1 | manager ×1 | manager ×3 |
| Agents | agent ×6 | agent ×4 | agent ×10 |
| Teams | — | — | 3 teams, agents split |
| Seats | 8 | 6 | 14 |

You appear in all three as `platform_owner`, holding one login.

Company C's managers each own a team; their agents see their team's
conversations. Managers cannot remove the business owner or each other's
admins. A and B run flat with no teams — the structure is there, unused,
costing nothing.

---

## Single deployment or one per client

The membership model above makes a single shared deployment viable. That
is the standard shape for B2B SaaS at this scale, and it is what makes
onboarding a new client a form submission rather than a deployment.

**The honest trade-off:** one deployment means one bad migration takes
every client down at once, and a compromised platform login reaches every
client's data. Separate instances contain both.

**Recommendation:** shared platform as the default. Keep the per-client
deployment path alive as a premium option for anyone who demands data
residency or contractual isolation — a bank, a clinic with patient data,
a government-adjacent client. Sell it as an upgrade rather than absorbing
the cost by default.

Whichever you choose, the schema above is the same. That is the point of
doing it now.

---

## Migration strategy

Order matters. Each step is independently deployable and reversible.

**1. Additive schema.** Create `teams`, `account_members`,
`platform_role`, `role_rank()`. Add the `manager` value to
`account_role_enum`. Nothing reads the new tables yet. Zero behaviour
change.

**2. Backfill.** For every profile with an `account_id`, insert the
equivalent `account_members` row. Verify counts match before proceeding.

**3. Flip the function.** Rewrite `is_account_member()` to read from
`account_members`. This is the moment authorization changes source. All
118 policies follow automatically. Test hard here — this single statement
is the whole security model.

**4. Platform gating.** Move AI config, automations, and flows from
`min_role => 'owner'` to `is_platform_staff()`. Update the matching UI
guards in `require-role.tsx` and the sidebar.

**5. Teams UI.** Team CRUD under Settings, team assignment on invite,
optional team filter on the inbox.

**6. Account switcher.** Platform-only control in the header that sets
`profiles.account_id` and reloads. This is what lets you work across
clients from one login.

**7. Drop the old column.** Only after a period of stable running,
remove `profiles.account_role`. Leave it in place until then — it costs
nothing and it is your rollback.

---

## Things to get right

**Invite flow.** Currently broken: signing up via an invite link creates a
new account instead of joining the inviter's. With `account_members` the
fix is natural — redeem inserts a membership row. Rebuild it as part of
step 2, and remove open signup entirely.

**One owner per account.** The existing `CHECK (role <> 'owner')` on
invitations should stay. Ownership transfers via an explicit action, not
an invite.

**Manager ceiling.** A manager must not be able to modify admins or the
owner. Enforce in the member-management RPC, not just the UI.

**Team scoping is a filter, not a wall.** Decide deliberately whether an
agent sees only their team's conversations or the whole inbox with a team
filter. Most inboxes work better with visibility and filtering; strict
walls cause "nobody answered that" failures. Start with filtering.

**Do not add account checks outside the function.** Every new table gets
RLS via `is_account_member()`. The day someone writes an inline
`account_id = ...` comparison, the seam is gone.

---

## What this does not solve

Deliberately out of scope, because these are additive and can wait:
Instagram and Messenger channels, booking, push notifications, voice-note
transcription, URL-based knowledge ingestion, billing and subscription
state.

None of them touch the tenancy model. All of them are safe to build after
clients are live.
