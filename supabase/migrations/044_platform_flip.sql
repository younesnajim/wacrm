-- ============================================================
-- 044_platform_flip.sql — platform architecture, step 3: the
-- is_account_member() flip.
--
-- See wacrm-platform-architecture.md. THIS IS THE MOMENT AUTHORIZATION
-- CHANGES SOURCE. Every one of the 160 RLS policies that call
-- is_account_member() follows automatically, unchanged.
--
-- Also included, per the audit findings this plan was built from:
--   - is_platform_staff() — new, for platform-only surfaces (step 4).
--   - The six storage.objects policies (flow-media, chat-media) that
--     read profiles.account_id directly instead of calling
--     is_account_member() — these don't "follow automatically" because
--     they never called the function in the first place. Rewritten
--     here so the flip is actually complete, not just for table RLS.
--
-- Prerequisite: 043_platform_dual_write.sql must have run and its
-- backfill verified — account_members must already reflect every
-- profile's membership before this ships, or callers lose access the
-- instant this function goes live.
--
-- Idempotent — CREATE OR REPLACE / DROP POLICY IF EXISTS throughout.
-- ============================================================

-- ============================================================
-- is_account_member() — now reads account_members, not profiles.
-- Platform staff bypass membership entirely (any profile with
-- platform_role set reaches every account at full authority).
-- Uses role_rank() (042) instead of an inline CASE.
-- ============================================================
CREATE OR REPLACE FUNCTION is_account_member(
  target_account_id UUID,
  min_role account_role_enum DEFAULT 'viewer'
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.user_id = auth.uid()
        AND p.platform_role IS NOT NULL
    )
    OR EXISTS (
      SELECT 1
      FROM account_members m
      WHERE m.user_id = auth.uid()
        AND m.account_id = target_account_id
        AND role_rank(m.role) >= role_rank(min_role)
    );
$$;

ALTER FUNCTION is_account_member(UUID, account_role_enum) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION is_account_member(UUID, account_role_enum) TO authenticated, service_role;

-- ============================================================
-- is_platform_staff() — for RLS/routes gated on platform authority
-- specifically, not "owner of this account". Step 4 wires this into
-- AI config / automations / flows; nothing calls it yet.
-- ============================================================
CREATE OR REPLACE FUNCTION public.is_platform_staff()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles p
    WHERE p.user_id = auth.uid()
      AND p.platform_role IS NOT NULL
  );
$$;

ALTER FUNCTION public.is_platform_staff() OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.is_platform_staff() TO authenticated, service_role;

-- ============================================================
-- safe_uuid() — text → uuid that returns NULL instead of raising on
-- malformed input. Needed for the storage policies below: casting an
-- attacker-controlled storage path segment straight to ::uuid would
-- turn a bad path into a hard error (500-ish) instead of a clean RLS
-- denial. is_account_member(NULL) safely evaluates false (no
-- account_members row has a NULL account_id), so this keeps the
-- policies fail-closed rather than fail-loud.
-- ============================================================
CREATE OR REPLACE FUNCTION public.safe_uuid(value TEXT)
RETURNS UUID
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  RETURN value::uuid;
EXCEPTION WHEN invalid_text_representation THEN
  RETURN NULL;
END;
$$;

ALTER FUNCTION public.safe_uuid(TEXT) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.safe_uuid(TEXT) TO authenticated, service_role;

-- ============================================================
-- Storage policies — flow-media, chat-media. These read
-- profiles.account_id directly today (audit finding: the only 6 of
-- 166 policies that don't call is_account_member()). Folder names are
-- `account-<uuid>/...`; extract the uuid and route it through
-- is_account_member() instead. Role tier is unchanged (still viewer+,
-- i.e. the default) — this fixes the authorization *source*, not the
-- threshold, which is a separate, not-requested change.
-- ============================================================

-- ---- flow-media (020_account_sharing_followups.sql) ----------------
DROP POLICY IF EXISTS "Members can upload flow media" ON storage.objects;
CREATE POLICY "Members can upload flow media"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'flow-media'
    AND is_account_member(safe_uuid(right((storage.foldername(name))[1], -8)))
  );

DROP POLICY IF EXISTS "Members can update flow media" ON storage.objects;
CREATE POLICY "Members can update flow media"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'flow-media'
    AND is_account_member(safe_uuid(right((storage.foldername(name))[1], -8)))
  );

DROP POLICY IF EXISTS "Members can delete flow media" ON storage.objects;
CREATE POLICY "Members can delete flow media"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'flow-media'
    AND is_account_member(safe_uuid(right((storage.foldername(name))[1], -8)))
  );

-- ---- chat-media (023_chat_media.sql) --------------------------------
DROP POLICY IF EXISTS "Members can upload chat media" ON storage.objects;
CREATE POLICY "Members can upload chat media"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'chat-media'
    AND is_account_member(safe_uuid(right((storage.foldername(name))[1], -8)))
  );

DROP POLICY IF EXISTS "Members can update chat media" ON storage.objects;
CREATE POLICY "Members can update chat media"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'chat-media'
    AND is_account_member(safe_uuid(right((storage.foldername(name))[1], -8)))
  );

DROP POLICY IF EXISTS "Members can delete chat media" ON storage.objects;
CREATE POLICY "Members can delete chat media"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'chat-media'
    AND is_account_member(safe_uuid(right((storage.foldername(name))[1], -8)))
  );
