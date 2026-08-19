-- ============================================================
-- 042_platform_schema.sql — platform architecture, step 1b: the rest
-- of the additive schema (everything except the account_role_enum
-- value, which had to go in its own transaction — see
-- 041_manager_role_value.sql).
--
-- See wacrm-platform-architecture.md. This is the remainder of step 1
-- of the "Migration strategy" section: platform_role, role_rank(),
-- teams, account_members.
--
-- ZERO BEHAVIOUR CHANGE. This migration does NOT touch
-- `is_account_member()` — it is not modified, not called by anything
-- new, and every existing RLS policy keeps reading `profiles` exactly
-- as before. `account_members` and `teams` are created with RLS
-- enabled and a SELECT policy (still gated through the unmodified
-- `is_account_member()`, since nothing else exists yet to gate on),
-- but nothing in the application reads or writes them yet. `role_rank()`
-- is created standalone — `is_account_member()` is rewritten to use it
-- (and to read `account_members` instead of `profiles`) in step 3,
-- not here.
--
-- account_members has NO insert/update/delete policy for `authenticated`
-- in this migration, deliberately. Step 2 adds writers as SECURITY
-- DEFINER RPCs (redeem_invitation, set_member_role,
-- transfer_account_ownership, handle_new_user, remove_account_member —
-- the same pattern 018/019 already use for profiles' privilege
-- columns), never a direct client-side table write. That keeps
-- membership mutation on the same supervised-RPC model the rest of the
-- account system already relies on, rather than opening a second,
-- less-audited path.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ---- platform_role_enum ---------------------------------------------
-- Platform authority is a separate axis from account_role — see the
-- doc's "Two levels of authority, not one" section. Three tiers:
-- platform_owner (you), platform_admin (future hires, same operational
-- access, no billing), platform_billing (billing/subscription
-- visibility only).
--
-- Created fresh in this transaction, so using it immediately below
-- (the ADD COLUMN) is safe — the 55P04 restriction only applies to
-- values added via ALTER TYPE ADD VALUE on an *existing* type, not to
-- a type's own values at CREATE TYPE time.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'platform_role_enum') THEN
    CREATE TYPE platform_role_enum AS ENUM ('platform_owner', 'platform_admin', 'platform_billing');
  END IF;
END $$;

-- Null for everyone except operator staff. Client users never have
-- this set. Not read by any RLS policy yet — that's step 4.
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS platform_role platform_role_enum;

-- ---- role_rank() ------------------------------------------------
-- Extracted from is_account_member()'s inline CASE (migration 017) so
-- adding a role is one edit instead of two parallel CASE blocks. Not
-- yet called by is_account_member() itself — see header comment.
-- 'manager' is safe to reference here because it was committed in
-- 041_manager_role_value.sql, a prior (already-committed) transaction.
CREATE OR REPLACE FUNCTION public.role_rank(role account_role_enum)
RETURNS INT
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE role
    WHEN 'owner'   THEN 5
    WHEN 'admin'   THEN 4
    WHEN 'manager' THEN 3
    WHEN 'agent'   THEN 2
    WHEN 'viewer'  THEN 1
  END;
$$;

ALTER FUNCTION public.role_rank(account_role_enum) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.role_rank(account_role_enum) TO authenticated, service_role;

-- ---- teams ------------------------------------------------------
CREATE TABLE IF NOT EXISTS teams (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, name)
);

ALTER TABLE teams ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS teams_select ON teams;
CREATE POLICY teams_select ON teams FOR SELECT
  USING (is_account_member(account_id));

-- Team CRUD is a settings-class action (Settings > Teams, step 5) —
-- admin+, matching every other settings resource (tags, custom fields,
-- message templates). Not RPC-gated like account_members: a team name
-- is a label, not a privilege grant, so a direct admin+ write is fine.
DROP POLICY IF EXISTS teams_insert ON teams;
CREATE POLICY teams_insert ON teams FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS teams_update ON teams;
CREATE POLICY teams_update ON teams FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS teams_delete ON teams;
CREATE POLICY teams_delete ON teams FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- ---- account_members ---------------------------------------------
-- The core change. Many-to-many membership — this is what
-- is_account_member() reads from as of step 3. Not populated until
-- step 2's backfill.
CREATE TABLE IF NOT EXISTS account_members (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role        account_role_enum NOT NULL,
  team_id     UUID REFERENCES teams(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, user_id)
);

-- Composite UNIQUE(account_id, user_id) above indexes "is user X a
-- member of account Y" efficiently, but not "every account user X
-- belongs to" — that's what the step-6 account switcher needs to list.
CREATE INDEX IF NOT EXISTS idx_account_members_user_id ON account_members(user_id);

ALTER TABLE account_members ENABLE ROW LEVEL SECURITY;

-- Read-only via RLS. Still gated through today's is_account_member()
-- (profiles-based) — self-referential once step 3 flips it to read
-- account_members, which is fine: a member can already see their own
-- account's roster today via profiles_select, and this mirrors that.
DROP POLICY IF EXISTS account_members_select ON account_members;
CREATE POLICY account_members_select ON account_members FOR SELECT
  USING (is_account_member(account_id));

-- Deliberately no INSERT/UPDATE/DELETE policy for `authenticated` —
-- see header comment. All mutation goes through SECURITY DEFINER RPCs
-- added in step 2.

-- ---- team routing on conversations / deals -----------------------
-- Nullable = unassigned. Not read by anything until step 5's optional
-- inbox team filter.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS team_id UUID REFERENCES teams(id) ON DELETE SET NULL;
ALTER TABLE deals         ADD COLUMN IF NOT EXISTS team_id UUID REFERENCES teams(id) ON DELETE SET NULL;
