"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import { useAuth } from "@/hooks/use-auth";
import { hasMinRole, type AccountRole } from "@/lib/auth/roles";

interface RequireRoleProps {
  /** Minimum role to render `children`. Uses the standard hierarchy
   *  owner > admin > agent > viewer. */
  min: AccountRole;
  /** What to render while the role is below `min` OR while we don't
   *  yet know the role (`profileLoading` is true). Defaults to
   *  `null` — most call sites just want the gated element to be
   *  absent until we're sure. Pass a placeholder if a layout slot
   *  would collapse and re-flow when the role resolves. */
  fallback?: ReactNode;
  /** When set, navigate here instead of just rendering `fallback`
   *  once the role is known to be below `min`. Use this to guard a
   *  whole route (e.g. a segment `layout.tsx`) rather than hide a
   *  single element — a page-scale gate should send the visitor
   *  somewhere they belong, not leave them on a blank page. */
  redirectTo?: string;
  children: ReactNode;
}

/**
 * `<RequireRole min="admin">…</RequireRole>` — conditional render
 * helper for UI gated by account role.
 *
 * Three states:
 *   1. profileLoading → render `fallback` (we don't know the role
 *      yet; fail closed so we never flash the gated content to an
 *      under-privileged user).
 *   2. role ≥ min     → render `children`.
 *   3. role < min     → render `fallback`, or navigate to
 *      `redirectTo` if one was given.
 *
 * Mirrors the server-side `requireRole(min)` from `@/lib/auth/account`
 * so client and server gates stay aligned by construction.
 */
export function RequireRole({
  min,
  fallback = null,
  redirectTo,
  children,
}: RequireRoleProps) {
  const { profileLoading, accountRole } = useAuth();
  const router = useRouter();
  const allowed = !!accountRole && hasMinRole(accountRole, min);

  useEffect(() => {
    if (!redirectTo || profileLoading || allowed) return;
    router.replace(redirectTo);
  }, [redirectTo, profileLoading, allowed, router]);

  if (profileLoading) return <>{fallback}</>;
  if (!allowed) return <>{fallback}</>;

  return <>{children}</>;
}
