'use client';

// ============================================================
// /join/[token] — the ONLY way to get an account now that open
// signup is retired. Creates the auth user (when needed) and
// redeems the invite, in that order, so the invitee lands in the
// inviter's account with the invited role — never as owner of a
// fresh personal account.
//
// States, driven by the peek result, auth status, and whether a
// fresh signup is waiting on email confirmation:
//
//   ┌──────────────────────┬───────────────┬───────────────────────────┐
//   │ peek                 │ auth          │ render                    │
//   ├──────────────────────┼───────────────┼───────────────────────────┤
//   │ loading              │ —             │ spinner                   │
//   │ ok:false (any reason)│ —             │ friendly error + sign in  │
//   │ ok:true              │ signed out    │ inline signup form        │
//   │   ↳ signup submitted,│               │ "check your email" card   │
//   │     no session yet   │               │                           │
//   │ ok:true              │ signed in     │ "Accept" button → redeem  │
//   └──────────────────────┴───────────────┴───────────────────────────┘
//
// Two different redeem triggers, deliberately:
//   - Fresh signup submitted from this page, session came back
//     immediately (email confirmation disabled on this project) →
//     redeem right away. Submitting the form *is* their consent;
//     no second click needed.
//   - Landing here already authenticated (existing user signing in,
//     or a fresh signup returning via /auth/callback after clicking
//     the confirmation email) → still requires an explicit "Accept
//     invitation" click. They may have arrived passively (an old
//     tab, a forwarded link), so we don't assume intent for them.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  AlertTriangle,
  CheckCircle,
  Loader2,
  MailX,
  ShieldCheck,
  UsersRound,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { createClient } from '@/lib/supabase/client';

interface PeekOk {
  ok: true;
  account_name: string;
  role: 'admin' | 'agent' | 'viewer';
  expires_at: string;
}
interface PeekFail {
  ok: false;
  reason: 'not_found' | 'used' | 'expired' | 'server_error';
}
type PeekResult = PeekOk | PeekFail;

export default function JoinPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token;
  const t = useTranslations('JoinPage');
  const locale = useLocale();

  const ROLE_LABEL: Record<PeekOk['role'], string> = {
    admin: t('roleAdmin'),
    agent: t('roleAgent'),
    viewer: t('roleViewer'),
  };

  const FAIL_COPY: Record<PeekFail['reason'], { title: string; body: string }> = {
    not_found: { title: t('failNotFoundTitle'), body: t('failNotFoundBody') },
    used: { title: t('failUsedTitle'), body: t('failUsedBody') },
    expired: { title: t('failExpiredTitle'), body: t('failExpiredBody') },
    server_error: { title: t('failServerErrorTitle'), body: t('failServerErrorBody') },
  };

  const [peek, setPeek] = useState<PeekResult | null>(null);
  // Local auth probe — the AuthProvider lives inside the (dashboard)
  // route group, so it doesn't reach this page. We hit Supabase
  // directly the same way `/login` does.
  const [authedUserId, setAuthedUserId] = useState<string | null | undefined>(
    undefined, // undefined = unknown / still loading; null = signed out
  );
  const [accepting, setAccepting] = useState(false);
  // `redeem_invitation` returns 409 when the caller's current account
  // has domain data, or they're already a member of a shared account.
  // A transient toast wasn't enough — the user has no actionable next
  // step. Surface a blocking modal that walks them through it.
  const [conflictMessage, setConflictMessage] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  // Inline signup form (replaces the old /signup redirect).
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [signupError, setSignupError] = useState<string | null>(null);
  const [signupLoading, setSignupLoading] = useState(false);
  // True once signUp() has succeeded but returned no session — this
  // project requires email confirmation, so redemption waits for the
  // visitor to click the link and return via /auth/callback.
  const [awaitingEmailConfirm, setAwaitingEmailConfirm] = useState(false);

  // Extracted so the "Try again" button on the server_error card
  // can re-run the same logic without remounting the component.
  const loadPeekAndAuth = useCallback(async () => {
    if (!token) return;
    setPeek(null);
    setAuthedUserId(undefined);
    try {
      const [peekRes, authRes] = await Promise.all([
        fetch(`/api/invitations/${encodeURIComponent(token)}/peek`, {
          cache: 'no-store',
        }),
        createClient().auth.getUser(),
      ]);
      const peekBody = (await peekRes.json()) as PeekResult;
      setPeek(peekBody);
      setAuthedUserId(authRes.data.user?.id ?? null);
    } catch (err) {
      console.error('[join] peek error:', err);
      setPeek({ ok: false, reason: 'server_error' });
      setAuthedUserId(null);
    }
  }, [token]);

  // Fetch peek + auth state on mount. The peek endpoint is
  // rate-limited per-IP (30/min) so double-mounting in React 19
  // strict mode dev is harmless. We also use the `cancelled` flag
  // to drop setState calls if the component unmounts mid-fetch.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const [peekRes, authRes] = await Promise.all([
          fetch(`/api/invitations/${encodeURIComponent(token)}/peek`, {
            cache: 'no-store',
          }),
          createClient().auth.getUser(),
        ]);
        const peekBody = (await peekRes.json()) as PeekResult;
        if (cancelled) return;
        setPeek(peekBody);
        setAuthedUserId(authRes.data.user?.id ?? null);
      } catch (err) {
        console.error('[join] peek error:', err);
        if (cancelled) return;
        setPeek({ ok: false, reason: 'server_error' });
        setAuthedUserId(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleAccept = useCallback(async () => {
    if (!token) return;
    setAccepting(true);
    try {
      const res = await fetch(
        `/api/invitations/${encodeURIComponent(token)}/redeem`,
        { method: 'POST' },
      );
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        // 409 = caller already has data / is in another shared
        // account. The redeem RPC's error message is descriptive
        // enough to show directly; we open a modal so the user has
        // a clear next-action (sign out → use different email)
        // rather than a 3-second toast.
        if (res.status === 409) {
          setConflictMessage(payload.error || t('conflictDefaultMessage'));
        } else {
          toast.error(payload.error || t('toastFailedAccept'));
        }
        setAccepting(false);
        return;
      }
      toast.success(t('toastWelcome'));
      // Full reload (not router.push) so AuthProvider re-fetches
      // the profile with the new account_id and account_role.
      window.location.href = '/dashboard';
    } catch (err) {
      console.error('[join] redeem error:', err);
      toast.error(t('toastServerUnreachable'));
      setAccepting(false);
    }
  }, [token, t]);

  // Creates the auth user, then redeems the invite in the same flow
  // when Supabase hands back a session immediately (email
  // confirmation disabled). `handle_new_user` will have already
  // bootstrapped a personal "owner" account for the brand-new user
  // the instant signUp() ran — that's fine, `redeem_invitation` is
  // built to detect exactly that (a fresh, empty, self-owned account)
  // and move the caller into the inviter's account instead, deleting
  // the orphan. See supabase/migrations/019_invitation_rpcs.sql.
  const handleSignupAndJoin = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setSignupError(null);

      if (password !== confirmPassword) {
        setSignupError(t('passwordMismatch'));
        return;
      }
      if (password.length < 6) {
        setSignupError(t('passwordTooShort'));
        return;
      }

      setSignupLoading(true);
      const supabase = createClient();
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: { full_name: fullName },
          // Only reached if this project requires email confirmation.
          // Lands back here, authenticated, via the PKCE code-exchange
          // route — then the "signed in → Accept invitation" branch
          // below takes over.
          emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(`/join/${token}`)}`,
        },
      });

      if (error) {
        setSignupError(error.message);
        setSignupLoading(false);
        return;
      }

      if (data.session) {
        // Confirmation disabled — we're authenticated right now.
        // Submitting this form was their consent; redeem immediately
        // instead of making them click Accept a second time.
        await handleAccept();
        setSignupLoading(false);
        return;
      }

      setAwaitingEmailConfirm(true);
      setSignupLoading(false);
    },
    [email, password, confirmPassword, fullName, token, t, handleAccept],
  );

  const handleSignOutAndRetry = useCallback(async () => {
    setSigningOut(true);
    try {
      await createClient().auth.signOut();
      // Hard reload so the new auth state propagates everywhere
      // (middleware, AuthProvider). Preserves the invite token in
      // the URL so the rebuilt page renders the signed-out CTA path.
      window.location.reload();
    } catch (err) {
      console.error('[join] sign-out error:', err);
      toast.error(t('toastSignOutFailed'));
      setSigningOut(false);
    }
  }, [t]);

  // ----- Loading state (peek pending OR auth not yet resolved) -----
  if (peek === null || authedUserId === undefined) {
    return (
      <Card className="w-full max-w-md border-border bg-card">
        <CardContent className="flex flex-col items-center gap-3 py-12">
          <Loader2 className="size-6 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">{t('verifying')}</p>
        </CardContent>
      </Card>
    );
  }

  // ----- Peek failed -----
  if (!peek.ok) {
    const copy = FAIL_COPY[peek.reason];
    return (
      <Card className="w-full max-w-md border-border bg-card">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-red-500/10">
            <MailX className="h-6 w-6 text-red-400" />
          </div>
          <CardTitle className="text-xl text-foreground">{copy.title}</CardTitle>
          <CardDescription className="text-muted-foreground">
            {copy.body}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {/* For server_error the failure is transient — the network
              flapped or the peek endpoint hiccupped. Try-again is
              the right primary action; sign-in stays as a secondary
              option in case they already have an account. Other
              failure reasons (not_found / used / expired) are
              terminal for this token — there's no open signup to
              fall back to, so the body copy above already points
              them at asking for a new invite. */}
          {peek.reason === 'server_error' ? (
            <>
              <Button
                onClick={loadPeekAndAuth}
                className="w-full bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {t('tryAgain')}
              </Button>
              <Link href="/login">
                <Button
                  variant="outline"
                  className="w-full border-border text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  {t('signIn')}
                </Button>
              </Link>
            </>
          ) : (
            <Link href="/login">
              <Button className="w-full bg-primary text-primary-foreground hover:bg-primary/90">
                {t('signIn')}
              </Button>
            </Link>
          )}
        </CardContent>
      </Card>
    );
  }

  // ----- Peek OK -----
  const inviteHeader = (
    <CardHeader className="items-center text-center">
      <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
        <UsersRound className="h-6 w-6 text-primary" />
      </div>
      <CardTitle className="text-xl text-foreground">
        {t.rich('titleInvited', {
          name: peek.account_name,
          accent: (chunks: React.ReactNode) => (
            <span className="text-primary">{chunks}</span>
          ),
        })}
      </CardTitle>
      <CardDescription className="text-muted-foreground">
        {t.rich('descJoinAs', {
          roleLabel: ROLE_LABEL[peek.role],
          date: new Date(peek.expires_at).toLocaleDateString(locale, {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
          }),
          role: (chunks: React.ReactNode) => (
            <span className="inline-flex items-center gap-1 text-foreground">
              <ShieldCheck className="size-3.5 text-primary" />
              {chunks}
            </span>
          ),
        })}
      </CardDescription>
    </CardHeader>
  );

  // ----- Authed: show Accept button -----
  if (authedUserId) {
    return (
      <>
        <Card className="w-full max-w-md border-border bg-card">
          {inviteHeader}
          <CardContent className="flex flex-col gap-3">
            <Button
              onClick={handleAccept}
              disabled={accepting}
              className="w-full bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {accepting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('accepting')}
                </>
              ) : (
                <>
                  <CheckCircle className="size-4" />
                  {t('acceptInvitation')}
                </>
              )}
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              {t('acceptingMovesAccount', { name: peek.account_name })}
            </p>
          </CardContent>
        </Card>

        {/* Conflict modal — opens when the redeem endpoint returns 409
            (caller already in a shared account or has domain data).
            Blocks the flow until the user picks a recovery action so
            they aren't stuck retrying an inevitable failure. */}
        <Dialog
          open={conflictMessage !== null}
          onOpenChange={(open) => {
            if (!open) setConflictMessage(null);
          }}
        >
          <DialogContent className="bg-popover border-border sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-popover-foreground">
                <AlertTriangle className="size-4 text-amber-400" />
                {t('conflictTitle', { name: peek.account_name })}
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                {conflictMessage}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2 py-2 text-xs text-muted-foreground">
              <p>{t('conflictBody', { name: peek.account_name })}</p>
            </div>
            <DialogFooter className="bg-popover border-border">
              <Button
                variant="outline"
                onClick={() => setConflictMessage(null)}
                className="border-border text-popover-foreground hover:bg-muted"
              >
                {t('staySignedIn')}
              </Button>
              <Button
                onClick={handleSignOutAndRetry}
                disabled={signingOut}
                className="bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {signingOut ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    {t('signingOut')}
                  </>
                ) : (
                  t('signOutDifferentEmail')
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </>
    );
  }

  // ----- Not authed, fresh signup submitted, waiting on email click -----
  if (awaitingEmailConfirm) {
    return (
      <Card className="w-full max-w-md border-border bg-card">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
            <CheckCircle className="h-6 w-6 text-primary" />
          </div>
          <CardTitle className="text-xl text-foreground">{t('checkEmailTitle')}</CardTitle>
          <CardDescription className="text-muted-foreground">
            {t.rich('checkEmailDesc', {
              email,
              bold: (chunks: React.ReactNode) => (
                <span className="text-foreground">{chunks}</span>
              ),
            })}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  // ----- Not authed: inline signup, then join -----
  return (
    <Card className="w-full max-w-md border-border bg-card">
      {inviteHeader}
      <CardContent className="flex flex-col gap-4">
        <form onSubmit={handleSignupAndJoin} className="flex flex-col gap-4">
          {signupError && (
            <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
              {signupError}
            </div>
          )}

          <div className="flex flex-col gap-2">
            <Label htmlFor="fullName" className="text-muted-foreground">
              {t('formFullNameLabel')}
            </Label>
            <Input
              id="fullName"
              type="text"
              placeholder={t('formFullNamePlaceholder')}
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              required
              className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="email" className="text-muted-foreground">
              {t('formEmailLabel')}
            </Label>
            <Input
              id="email"
              type="email"
              placeholder={t('formEmailPlaceholder')}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="password" className="text-muted-foreground">
              {t('formPasswordLabel')}
            </Label>
            <Input
              id="password"
              type="password"
              placeholder={t('formPasswordPlaceholder')}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="confirmPassword" className="text-muted-foreground">
              {t('formConfirmPasswordLabel')}
            </Label>
            <Input
              id="confirmPassword"
              type="password"
              placeholder={t('formConfirmPasswordPlaceholder')}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
            />
          </div>

          <Button
            type="submit"
            disabled={signupLoading}
            className="mt-2 h-10 w-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {signupLoading ? t('submitting') : t('createAccountJoin')}
          </Button>
        </form>

        <Link href={`/login?invite=${encodeURIComponent(token!)}`}>
          <Button
            variant="outline"
            className="w-full border-border text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {t('alreadyHaveAccount')}
          </Button>
        </Link>
      </CardContent>
    </Card>
  );
}
