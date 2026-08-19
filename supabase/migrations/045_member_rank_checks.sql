-- ============================================================
-- 045_member_rank_checks.sql — close the peer-escalation hole in
-- member management.
--
-- Confirmed by testing: an admin could create an invite at Admin
-- level, minting a peer who could then remove the business owner.
-- The existing checks only asked "is the caller admin+?" — never
-- "does the caller outrank the specific person/role they're acting
-- on?". Same gap in set_member_role and remove_account_member.
--
-- New rule, enforced with role_rank() so it stays consistent with
-- is_account_member():
--   owner   -> can act on admin, manager, agent, viewer
--   admin   -> can act on manager, agent, viewer
--   manager -> can act on agent, viewer
--   agent, viewer -> cannot manage members at all
--
-- The "cannot manage members at all" floor for agent/viewer is NOT
-- automatic from rank comparison alone — agent(2) > viewer(1), so a
-- bare "caller must outrank target" check would let an agent manage
-- a viewer. Each function keeps an explicit `role_rank(caller) <
-- role_rank('manager')` floor check for that reason.
--
-- Idempotent — CREATE OR REPLACE throughout.
-- ============================================================

-- ============================================================
-- set_member_role() — now requires the caller to outrank BOTH the
-- target's current role and the proposed new role, not just "be
-- admin+". Everything else (the account_members dual-write from
-- 043) is unchanged.
-- ============================================================
CREATE OR REPLACE FUNCTION public.set_member_role(
  p_user_id UUID,
  p_new_role account_role_enum
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_target_account_id UUID;
  v_target_role account_role_enum;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id, account_role
  INTO v_caller_account_id, v_caller_role
  FROM profiles
  WHERE user_id = auth.uid();

  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;

  -- Floor: agent/viewer cannot manage members at all, regardless of
  -- target. Not implied by the rank check below (agent outranks
  -- viewer numerically) — see header comment.
  IF role_rank(v_caller_role) < role_rank('manager') THEN
    RAISE EXCEPTION 'This action requires the manager role or higher'
      USING ERRCODE = '42501';
  END IF;

  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot change your own role'
      USING ERRCODE = '22023';
  END IF;

  SELECT account_id, account_role
  INTO v_target_account_id, v_target_role
  FROM profiles
  WHERE user_id = p_user_id;

  IF v_target_account_id IS NULL THEN
    RAISE EXCEPTION 'Target user not found' USING ERRCODE = '22023';
  END IF;

  IF v_target_account_id <> v_caller_account_id THEN
    RAISE EXCEPTION 'Target user is not a member of your account'
      USING ERRCODE = '42501';
  END IF;

  -- Owner changes go through transfer_account_ownership — kept as
  -- explicit checks for the clearer message; the rank check below
  -- would also catch both (no caller can outrank 'owner', the top
  -- rank), just with a less specific error.
  IF v_target_role = 'owner' THEN
    RAISE EXCEPTION 'Use transfer_account_ownership to demote an owner'
      USING ERRCODE = '22023';
  END IF;
  IF p_new_role = 'owner' THEN
    RAISE EXCEPTION 'Use transfer_account_ownership to promote to owner'
      USING ERRCODE = '22023';
  END IF;

  -- The actual fix: caller must strictly outrank both the target's
  -- current role and the role being assigned. Blocks an admin
  -- promoting an agent to admin (mints a peer) and an admin editing
  -- another admin (acts on a peer) alike.
  IF role_rank(v_caller_role) <= role_rank(v_target_role) THEN
    RAISE EXCEPTION 'You can only manage members with a role below your own'
      USING ERRCODE = '42501';
  END IF;
  IF role_rank(v_caller_role) <= role_rank(p_new_role) THEN
    RAISE EXCEPTION 'You can only assign a role below your own'
      USING ERRCODE = '42501';
  END IF;

  UPDATE profiles
  SET account_role = p_new_role
  WHERE user_id = p_user_id;

  -- Keep account_members in lockstep. Upsert rather than a bare
  -- UPDATE so a profile whose membership row is somehow still missing
  -- self-heals instead of silently staying out of sync.
  INSERT INTO account_members (account_id, user_id, role)
  VALUES (v_target_account_id, p_user_id, p_new_role)
  ON CONFLICT (account_id, user_id) DO UPDATE SET role = EXCLUDED.role;
END;
$$;

ALTER FUNCTION public.set_member_role(UUID, account_role_enum) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_member_role(UUID, account_role_enum) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_member_role(UUID, account_role_enum) TO authenticated;

-- ============================================================
-- remove_account_member() — same rank check, applied to removal.
-- ============================================================
CREATE OR REPLACE FUNCTION public.remove_account_member(
  p_user_id UUID
) RETURNS UUID  -- the new personal account id
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_target_account_id UUID;
  v_target_role account_role_enum;
  v_target_name TEXT;
  v_target_email TEXT;
  v_new_account_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id, account_role
  INTO v_caller_account_id, v_caller_role
  FROM profiles
  WHERE user_id = auth.uid();

  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;

  -- Floor: agent/viewer cannot manage members at all. See header
  -- comment on set_member_role for why this isn't implied by the
  -- rank check below.
  IF role_rank(v_caller_role) < role_rank('manager') THEN
    RAISE EXCEPTION 'This action requires the manager role or higher'
      USING ERRCODE = '42501';
  END IF;

  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot remove yourself; transfer ownership or leave the account instead'
      USING ERRCODE = '22023';
  END IF;

  SELECT account_id, account_role, full_name, email
  INTO v_target_account_id, v_target_role, v_target_name, v_target_email
  FROM profiles
  WHERE user_id = p_user_id;

  IF v_target_account_id IS NULL THEN
    RAISE EXCEPTION 'Target user not found' USING ERRCODE = '22023';
  END IF;

  IF v_target_account_id <> v_caller_account_id THEN
    RAISE EXCEPTION 'Target user is not a member of your account'
      USING ERRCODE = '42501';
  END IF;

  -- Kept explicit for the clearer message — the rank check below
  -- would also catch this (no caller outranks 'owner').
  IF v_target_role = 'owner' THEN
    RAISE EXCEPTION 'Cannot remove the account owner; transfer ownership first'
      USING ERRCODE = '22023';
  END IF;

  -- The actual fix: caller must strictly outrank the target. Blocks
  -- an admin removing another admin (a peer).
  IF role_rank(v_caller_role) <= role_rank(v_target_role) THEN
    RAISE EXCEPTION 'You can only remove members with a role below your own'
      USING ERRCODE = '42501';
  END IF;

  -- Spin up a fresh personal account for the removed user. Mirror
  -- of handle_new_user's logic — keep them whole, just relocated.
  INSERT INTO accounts (name, owner_user_id)
  VALUES (
    COALESCE(NULLIF(v_target_name, ''), v_target_email, 'My account'),
    p_user_id
  )
  RETURNING id INTO v_new_account_id;

  UPDATE profiles
  SET account_id = v_new_account_id,
      account_role = 'owner'
  WHERE user_id = p_user_id;

  -- Drop membership in the account they were removed from, grant
  -- membership in their fresh personal account.
  DELETE FROM account_members
  WHERE account_id = v_target_account_id AND user_id = p_user_id;

  INSERT INTO account_members (account_id, user_id, role)
  VALUES (v_new_account_id, p_user_id, 'owner');

  RETURN v_new_account_id;
END;
$$;

ALTER FUNCTION public.remove_account_member(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.remove_account_member(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.remove_account_member(UUID) TO authenticated;
