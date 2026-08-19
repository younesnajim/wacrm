"use client";

import { RequireRole } from "@/components/auth/require-role";

// AI Agents is an operator/owner surface — see automations/layout.tsx
// for the rationale.
export default function AgentsLayout({
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
