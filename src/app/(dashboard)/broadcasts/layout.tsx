"use client";

import { RequireRole } from "@/components/auth/require-role";

// Broadcasts is admin+ (see 046_pass2_permissions.sql and the sidebar's
// `minRole` on this entry): an agent sending a bad broadcast to
// thousands of contacts is a Meta quality-rating incident that can get
// the client's WhatsApp number restricted. Gated at the segment level
// (list, new, detail) so a stale bookmark or hand-typed URL bounces to
// /dashboard instead of rendering a page whose reads/writes will just
// 403/RLS-reject underneath it.
export default function BroadcastsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <RequireRole min="admin" redirectTo="/dashboard">
      {children}
    </RequireRole>
  );
}
