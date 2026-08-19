"use client";

import { RequireRole } from "@/components/auth/require-role";

// Flows is an operator/owner surface — see automations/layout.tsx for
// the rationale. Gates the list, the builder, and the runs log in one
// place instead of three.
export default function FlowsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <RequireRole min="owner" redirectTo="/dashboard">
      {children}
    </RequireRole>
  );
}
