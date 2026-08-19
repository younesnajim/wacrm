import { redirect } from "next/navigation";

// Open signup is retired — every account arrives by invite now (see
// join/[token]). Anyone who still hits this URL (an old bookmark, a
// stale link) gets sent to /login rather than a 404 or a dead form.
export default function SignupPage() {
  redirect("/login");
}
