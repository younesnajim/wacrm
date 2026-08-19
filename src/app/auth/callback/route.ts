import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// PKCE code-exchange landing page. `@supabase/ssr`'s browser client
// defaults to `flowType: 'pkce'`, so every email-confirmation and
// password-reset link Supabase sends carries a `?code=` param that
// must be exchanged for a session via a *server* round-trip — the
// browser can't do this itself. Without this route, a visitor
// clicking such a link lands back in the app with a code sitting
// unused in the URL and no session, which is why invite redemption
// silently failed: the join page never saw them as authenticated.
//
// `next` names where to go once the session is set — e.g.
// `/join/<token>` (invite acceptance) or `/reset-password`.
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const next = searchParams.get('next') ?? '/dashboard'

  if (code) {
    const supabase = await createClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`)
    }
    console.error('[auth/callback] exchangeCodeForSession failed:', error.message)
  }

  return NextResponse.redirect(`${origin}/login?error=auth_callback_failed`)
}
