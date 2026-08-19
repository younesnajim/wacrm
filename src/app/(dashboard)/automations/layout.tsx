"use client";

import { RequireRole } from "@/components/auth/require-role";

// Automations is an operator/owner surface — client teammates (admin,
// agent, viewer) don't build or edit automations, so every route under
// here (list, new, edit, logs) is gated at the segment level rather
// than repeating the check in each page. A non-owner who lands on any
// /automations/* URL (e.g. a stale bookmark) is bounced to /dashboard
// instead of seeing a blank or broken page.
export default function AutomationsLayout({
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
