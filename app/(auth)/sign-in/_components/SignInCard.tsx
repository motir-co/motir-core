'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState, type FormEvent } from 'react';
import { Mail, Lock, Eye, EyeOff, Info, Sparkles } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { OAuthSignInClientDto } from '@/lib/dto/oauthConnections';
import { Button, buttonVariants } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { signIn } from '@/lib/auth/client';
import { formatUserCode, readDeviceUserCode } from '@/lib/cliDevice/userCode';
import {
  AuthShell,
  CodeChip,
  OrDivider,
  FormAlert,
  IdeaCarried,
} from '../../_components/AuthShell';
import { GoogleButton } from '../../_components/GoogleButton';
import { PasskeySignInButton } from '../../_components/PasskeySignInButton';
import { TwoFactorChallenge } from './TwoFactorChallenge';
import {
  TWO_FACTOR_OTP_PERIOD_MINUTES,
  TWO_FACTOR_TRUST_DEVICE_MAX_AGE_SECONDS,
} from '@/lib/auth/twoFactorConfig';
import {
  ONBOARDING_ENTRY_PATH,
  ONBOARDING_SIGNUP_DOOR_PATH,
  isOnboardingDestination,
  resolvePostAuthDestination,
} from '@/lib/navigation/landing';

// ⚠️ THE DESTINATIONS ARE IMPORTED NOW (MOTIR-3373). This file used to carry
// its own `ONBOARDING_ENTRY_PATH` constant and a hardcoded home default, under a
// comment explaining that the canonical constant lived in a `server-only` module
// a client component must not import. That was a good reason not to import THAT
// module and no reason to retype the value: `lib/navigation/landing.ts` is a
// plain module precisely so both halves of the app can share one answer.

/**
 * Two-step sign-in (Clay pattern):
 *
 *   step 'email'    — Google button + email field + Continue. Renders
 *                     mockup 01.
 *   step 'password' — email read-only, password field, "Forgot password?"
 *                     link ABOVE the password field, Continue button.
 *                     Renders mockup 02.
 *
 * One route, internal state. The URL stays /sign-in throughout (per
 * Story-1.1 decision recorded in MOTIR.md). On wrong password, the
 * user stays on step 2 and sees an inline error (mockup 07).
 *
 * The "Forgot password?" position is ABOVE the password field — that's
 * the Clay pattern, not the more common below-field placement.
 *
 * ⚠️ THIS IS THE ISLAND, NOT THE ROUTE (MOTIR-3372). `app/(auth)/sign-in/page.tsx`
 * is a server shell that resolves the session and bounces a reader who is already
 * signed in; only when the form is actually the right answer does it render this.
 * The file moved here unchanged apart from that extraction and the `sessionActive`
 * prop below — everything about the two-step flow is as it was.
 */
/** An OAuth authorize request waiting on this sign-in (MOTIR-6985): the app's
 *  registered name, or null when it registered none. */
/** The app an authorize request is waiting on — `OAuthSignInClientDto`. */
export type SignInOAuthApp = OAuthSignInClientDto;

export function SignInCard({
  sessionActive = false,
  oauthApp = null,
  previewHost = null,
}: {
  sessionActive?: boolean;
  oauthApp?: SignInOAuthApp | null;
  /** The preview this sign-in opens, when it came from preview-access
   *  (MOTIR-5779) — shown in a banner above the card. */
  previewHost?: string | null;
}) {
  // useSearchParams must be wrapped in Suspense for Next 16's static
  // pre-rendering — the suspense boundary lets the static shell stream
  // while the search params resolve client-side.
  return (
    <>
      {previewHost ? <PreviewBanner host={previewHost} /> : null}
      <Suspense fallback={<SignInShell />}>
        <SignInForm sessionActive={sessionActive} oauthApp={oauthApp} />
      </Suspense>
    </>
  );
}

/**
 * The preview banner (design `design/preview/preview-gate.mock.html` Panel 1):
 * the shipped sign-in, unchanged, with one note above it naming only the
 * address — already in the viewer's address bar — and never the project, which
 * a signed-out viewer may have no right to know.
 */
function PreviewBanner({ host }: { host: string }) {
  const t = useTranslations('previewGate');
  return (
    <div
      role="note"
      className="flex items-start gap-2.5 rounded-(--radius-card) bg-(--el-tint-sky) p-(--spacing-card-padding-12) font-sans text-[13px] leading-normal text-(--el-text-strong)"
    >
      <Info className="mt-0.5 h-4 w-4 flex-none" aria-hidden />
      <span className="min-w-0">
        {t.rich('signIn.banner', {
          host,
          chip: (chunks) => (
            <code className="rounded-(--radius-control) bg-(--el-code-bg) px-(--spacing-tooltip-x) py-(--spacing-tooltip-y) font-mono text-[11.5px] break-all text-(--el-code-text)">
              {chunks}
            </code>
          ),
        })}
      </span>
    </div>
  );
}

function SignInShell() {
  const t = useTranslations('auth');
  // The headline + subhead stay stable across both states, so the
  // streaming fallback renders the same shell as the loaded form.
  return (
    <AuthShell headline={t('welcomeBack')} subhead={t('signInSubhead')}>
      <div className="flex flex-col gap-5" aria-hidden />
    </AuthShell>
  );
}

function SignInForm({
  sessionActive,
  oauthApp,
}: {
  sessionActive: boolean;
  oauthApp: SignInOAuthApp | null;
}) {
  const t = useTranslations('auth');
  const tDevice = useTranslations('device');
  const tOAuth = useTranslations('oauthConsent');
  const searchParams = useSearchParams();
  const router = useRouter();
  // A cross-origin idea draft handed off from the marketing hero (Subtask 7.22.2
  // / MOTIR-1458). When present, we claim it (planting the preserved-idea cookie)
  // and default the post-auth destination to onboarding so the idea seeds the
  // first chat turn. An explicit `next=` still wins if the caller set one.
  const draftId = searchParams.get('draft');
  // The post-auth landing (Story MOTIR-2649 · Subtask MOTIR-2654): `/home`, the
  // signed-in landing surface, NOT `/dashboard`. Signing in is the moment the
  // reader asks "what should I do now?", and the dashboards list answers a
  // different question — it is an index of reporting artifacts, most of which a
  // given person did not create. `/dashboard` keeps its route and its own nav
  // entry; only this default moved.
  //
  // An explicit `?next=` still WINS (the CLI-connect hand-off and every
  // deep-link rely on it), and the `?draft=` → onboarding branch is untouched.
  const callbackURL = resolvePostAuthDestination({ next: searchParams.get('next'), draftId });
  const [carriedIdea, setCarriedIdea] = useState<string | null>(null);
  // The CLI-connect hand-off (Story MOTIR-1863 · Subtask MOTIR-1867): `/device`
  // sends a signed-out visitor here with `?next=/device?user_code=…`, and this
  // banner is the ONLY change the `design/cli-connect/` mock asks of the shipped
  // sign-in card — it tells the reader the code survived the boundary, which is
  // what makes the round trip feel like one flow rather than two. `null` means
  // "not a device hand-off"; `''` means a bare `/device` return with no code yet.
  const deviceUserCode = readDeviceUserCode(callbackURL);
  // ⚠️ IS THIS SURFACE ALREADY SERVING THE ONBOARDING INTENT? (MOTIR-4402)
  //
  // `/onboarding` is authenticated, so the layout bounces a signed-out visitor
  // back here with `next=/onboarding` — and until this line the card rendered
  // that return byte-for-byte identically to the arrival: same headline, same
  // form, same "Plan with AI" door. The net observable effect of pressing the
  // door was that the URL gained a query string.
  //
  // Two things follow from knowing, and they are the same fact from both sides:
  // the card SAYS what it is carrying (the banner below, the third instance of
  // `IdeaCarried` — an idea, a device code, and now an intent), and it does NOT
  // re-offer a door onto the thing it is already serving.
  const carryingOnboardingIntent = isOnboardingDestination(callbackURL);

  // Claim the draft ONCE on mount: POST swaps the opaque id for the idea text and
  // plants the `motir_pending_idea` cookie server-side. On any failure (missing /
  // expired / forged id, or a network error) we simply don't show the banner and
  // the page degrades to a normal login — no crash, no leak. The claim consumes
  // the draft, so the ref-guard also stops a re-claim on re-render.
  //
  // ⚠️ AND THIS IS WHY A SIGNED-IN READER STILL REACHES THIS FORM WHEN `?draft=`
  // IS PRESENT (MOTIR-3372). The server shell bounces them for every other
  // arrival, but the claim is a CLIENT POST whose whole point is the cookie it
  // plants, and a Server Component may not set a cookie during render — so a
  // shell that redirected first would drop the idea the reader typed on
  // motir.co, silently. The form renders, the claim runs, and THEN the reader
  // goes on to onboarding, which is where the planted cookie is read.
  const claimedRef = useRef(false);
  useEffect(() => {
    if (!draftId || claimedRef.current) return;
    claimedRef.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/idea-draft/${encodeURIComponent(draftId)}/claim`, {
          method: 'POST',
        });
        if (res.ok) {
          const data = (await res.json()) as { idea?: string };
          if (!cancelled && data.idea) setCarriedIdea(data.idea);
        }
      } catch {
        // Network error → normal login; the cookie simply isn't planted.
      } finally {
        // Settled either way: a reader who is already signed in has nothing to
        // authenticate, so send them where the draft was going. On a failed
        // claim that is still right — onboarding without a seeded idea is a
        // working flow, and a login form for the account they are in is not.
        if (!cancelled && sessionActive) router.replace(ONBOARDING_ENTRY_PATH);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [draftId, sessionActive, router]);

  // Story 8.11 · MOTIR-1221 adds the THIRD step. It is reached only from a
  // sign-in that answered `twoFactorRedirect`, never by typing — see
  // `TwoFactorChallenge`'s header for why it is a step rather than a route.
  const [step, setStep] = useState<'email' | 'password' | 'twoFactor'>('email');
  /** What the sign-in said this account can answer the challenge with. */
  const [twoFactorMethods, setTwoFactorMethods] = useState<string[]>([]);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  // pageError is seeded from a `?error=` query param (Better-Auth bounces
  // back here on a denied/failed Google consent — mockup 06). We seed it
  // once during initial render via useState's lazy initializer, then let
  // the user dismiss/replace it through subsequent interactions. Pulling
  // it out of the URL into local state avoids the cascading-render trap
  // that useEffect+setState would create (react-hooks/set-state-in-effect).
  const [pageError, setPageError] = useState(() =>
    searchParams.get('error') ? t('googleSignInIncomplete') : '',
  );
  const [passwordError, setPasswordError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function onContinueEmail(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPageError('');
    if (!email.trim()) return;
    // We DON'T pre-check the email server-side here — that would enumerate
    // accounts. Always advance to the password step; the password submit
    // surfaces the unified "email or password is wrong" error if either
    // is invalid.
    setStep('password');
  }

  async function onSubmitPassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPasswordError('');
    setPageError('');
    if (!password) return;
    setSubmitting(true);
    try {
      // ONE navigation to `callbackURL`, and it is a DOCUMENT one (MOTIR-2645).
      //
      // Passing `callbackURL` makes the endpoint answer `{ redirect: true, url }`
      // (better-auth `api/routes/sign-in.mjs`), and the CLIENT's `redirect` fetch
      // plugin then assigns `window.location.href = url` from its onSuccess hook
      // — a full page load. This used to ALSO be followed by a
      // `router.push(callbackURL)`, so two navigations raced to one destination;
      // the loser was aborted at the winner's commit, and when that landed the
      // wrong side of a test's next `page.goto` it aborted THAT instead ("…is
      // interrupted by another navigation to …/dashboard", three CI occurrences).
      //
      // The soft push is the one that had to go, not the document load: the
      // user's saved APPEARANCE is server-applied onto the root layout's `<html>`
      // (data-theme / data-palette / data-style / data-type), and an RSC
      // navigation cannot rewrite those — only a fresh document render can. So a
      // returning user signing in on a new device needs this page to be REPLACED,
      // not soft-navigated away from, or they land on the anonymous defaults.
      // `tests/e2e/appearance-sync.spec.ts` is the assertion that says so; the
      // race meant it was already coin-flipping on whichever navigation won.
      const result = await signIn.email({ email, password, callbackURL });
      if (result?.error) {
        // Unified error message — no enumeration — EXCEPT for a suspended
        // account, which is raised only after the credential verified. See
        // `signInErrorKey`.
        setPasswordError(t(signInErrorKey(result.error)));
        setSubmitting(false);
        return;
      }
      // ⚠️ THE PASSWORD WAS RIGHT AND THERE IS STILL NO SESSION (MOTIR-1221).
      // With 2FA enrolled, the plugin intercepts the sign-in BEFORE
      // `createSession`: it sets a short-lived signed `two_factor` cookie and
      // answers `{ twoFactorRedirect: true, twoFactorMethods }` instead of
      // `{ redirect, url }`. So the redirect fetch plugin does nothing, this
      // component is NOT on its way out, and the third step renders in place.
      //
      // `twoFactorClient()` is registered with no `twoFactorPage` /
      // `onTwoFactorRedirect` precisely so that hook stays inert and the branch
      // lives here, where the card already holds the email and the callbackURL.
      const twoFactorRedirect = (result?.data as { twoFactorRedirect?: boolean } | undefined)
        ?.twoFactorRedirect;
      if (twoFactorRedirect) {
        const methods = (result?.data as { twoFactorMethods?: string[] } | undefined)
          ?.twoFactorMethods;
        setTwoFactorMethods(methods ?? []);
        setStep('twoFactor');
        setSubmitting(false);
        return;
      }
      // No client-side navigation on success, on purpose — see above. The
      // redirect plugin has already started the document load, and this
      // component is on its way out, so `submitting` stays true until the page
      // is replaced (which is what it did before, whenever that load won).
    } catch {
      setPasswordError(t('wrongPassword'));
      setSubmitting(false);
    }
  }

  // Step 3 replaces the whole card body: the reader has finished authenticating
  // with what they know and is now proving what they have, so the Google button,
  // the "Plan with AI" door and the sign-up footer are all noise at best and a
  // way around the challenge at worst.
  if (step === 'twoFactor') {
    return (
      <TwoFactorChallenge
        email={email}
        callbackURL={callbackURL}
        methods={twoFactorMethods}
        trustDeviceDays={Math.round(TWO_FACTOR_TRUST_DEVICE_MAX_AGE_SECONDS / 86_400)}
        otpPeriodMinutes={TWO_FACTOR_OTP_PERIOD_MINUTES}
      />
    );
  }

  return (
    <AuthShell headline={t('welcomeBack')} subhead={t('signInSubhead')}>
      {carriedIdea ? <IdeaCarried label={t('ideaCarriedLabel')}>{carriedIdea}</IdeaCarried> : null}
      {deviceUserCode !== null ? (
        <IdeaCarried label={tDevice('signInCarried.label')}>
          {deviceUserCode
            ? tDevice.rich('signInCarried.value', {
                code: formatUserCode(deviceUserCode),
                chip: (chunks) => <CodeChip>{chunks}</CodeChip>,
              })
            : tDevice('signInCarried.valueNoCode')}
        </IdeaCarried>
      ) : null}
      {/* An MCP client's authorize request is waiting (MOTIR-6985, design
          `design/auth/oauth-consent.mock.html` Panel 5) — the fourth
          `IdeaCarried`: it names the app, so the round trip through sign-in
          reads as one flow. Its verified-by-domain delta (MOTIR-7174, Panel V3)
          leads a verified app with its host, and never states a self-registered
          app's name as fact. */}
      {oauthApp ? (
        <IdeaCarried label={tOAuth('signIn.carriedLabel')}>
          <OAuthHandOff app={oauthApp} />
        </IdeaCarried>
      ) : null}
      {carryingOnboardingIntent ? (
        <IdeaCarried label={t('onboardingCarriedLabel')}>
          {t('onboardingCarriedSignIn')}
        </IdeaCarried>
      ) : null}
      {pageError ? <FormAlert>{pageError}</FormAlert> : null}

      {step === 'email' ? (
        <form onSubmit={onContinueEmail} className="flex flex-col gap-5" noValidate>
          {/* Google button first per the AC: tab order = Google → passkey →
              email → continue. The passkey control sits directly under it and
              ABOVE the rule (`design/auth/passkey-sign-in.mock.html`, panel 2):
              everything above the rule signs you in without typing anything,
              everything below it is the email path. Below the rule it would read
              as an alternative to the email FIELD, which it is not. */}
          <GoogleButton callbackURL={callbackURL} onError={setPageError} />
          <PasskeySignInButton callbackURL={callbackURL} onError={setPageError} />
          <OrDivider />
          <Input
            type="email"
            name="email"
            autoComplete="email"
            inputMode="email"
            placeholder={t('emailAddress')}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            addonStart={<Mail className="h-5 w-5" aria-hidden />}
            aria-label={t('emailAddress')}
            required
            autoFocus
          />
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={submitting}>
            {submitting ? t('checking') : t('continue')}
          </Button>
          <FooterLink prompt={t('dontHaveAccount')} linkText={t('signUp')} href="/sign-up" />
        </form>
      ) : (
        <form onSubmit={onSubmitPassword} className="flex flex-col gap-5" noValidate>
          {/* Email — read-only display, click to edit (flips back to step 'email'). */}
          <div className="flex flex-col gap-1.5">
            <div
              className="flex h-(--height-input) w-full items-center gap-2 rounded-(--radius-input) bg-(--el-surface) px-(--spacing-input-x)"
              aria-label={t('signingInAs', { email })}
            >
              <Mail className="text-(--el-text-muted) h-5 w-5" aria-hidden />
              <span className="flex-1 truncate font-sans text-sm text-(--el-text)">{email}</span>
            </div>
            <button
              type="button"
              onClick={() => {
                setStep('email');
                setPassword('');
                setPasswordError('');
              }}
              className="self-start font-sans text-xs text-(--el-link) hover:text-(--el-link-pressed) focus-visible:outline-none focus-visible:underline"
            >
              {t('useDifferentEmail')}
            </button>
          </div>

          {/* Forgot password — ABOVE the field, per the Clay pattern + mockup 02. */}
          <Link
            href="/reset-password"
            className="self-start font-sans text-sm font-medium text-(--el-link) hover:text-(--el-link-pressed) focus-visible:outline-none focus-visible:underline"
          >
            {t('forgotPassword')}
          </Link>

          <Input
            type={showPassword ? 'text' : 'password'}
            name="password"
            autoComplete="current-password"
            placeholder={t('password')}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            addonStart={<Lock className="h-5 w-5" aria-hidden />}
            addonEnd={
              <button
                type="button"
                onClick={() => setShowPassword((s) => !s)}
                aria-label={showPassword ? t('hidePassword') : t('showPassword')}
                className="inline-flex h-6 w-6 items-center justify-center rounded-(--radius-control) text-(--el-text-muted) hover:text-(--el-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
              >
                {showPassword ? (
                  <EyeOff className="h-4 w-4" aria-hidden />
                ) : (
                  <Eye className="h-4 w-4" aria-hidden />
                )}
              </button>
            }
            aria-label={t('password')}
            error={passwordError || undefined}
            required
            autoFocus
          />

          <Button type="submit" variant="primary" size="lg" className="w-full" loading={submitting}>
            {submitting ? t('signingIn') : t('continue')}
          </Button>

          <FooterLink prompt={t('dontHaveAccount')} linkText={t('signUp')} href="/sign-up" />
        </form>
      )}

      {/* Plan with AI — the onboarding door (Subtask 7.22.1 / MOTIR-1457).
          The entry into the start-fresh AI planning flow from the login
          surface, the front-door role the relocated marketing hero used to
          hold.

          ⚠️ IT TARGETS SIGN-UP, NOT `/onboarding` (MOTIR-4402). Its lead is
          "Have a project idea?" — it addresses somebody who does NOT have an
          account, and onboarding is authenticated, so pointing it at the
          entrance sent the one reader who could see it round a loop that
          rendered identically to where they started. The destination is
          composed in `lib/navigation/landing.ts`, which owns the entrance, and
          the intent travels in `?next=` — the carrier both auth surfaces
          already honour and sanitize. Do NOT add a second one.

          And it is NOT rendered when this card is already serving that intent:
          re-offering a door onto the surface you are standing on is how the
          original loop read as a working control. */}
      {oauthApp ? (
        <p className="font-sans text-xs leading-relaxed text-(--el-text-muted)">
          {tOAuth('signIn.foot')}
        </p>
      ) : null}
      {carryingOnboardingIntent ? null : (
        <div className="flex flex-col gap-3 border-t border-(--el-border) pt-6">
          <p className="text-center font-sans text-sm text-(--el-text-muted)">
            {t('planWithAiLead')}
          </p>
          <Link
            href={ONBOARDING_SIGNUP_DOOR_PATH}
            className={`${buttonVariants({ variant: 'secondary', size: 'lg' })} w-full`}
          >
            <Sparkles className="h-4 w-4" aria-hidden />
            {t('planWithAI')}
          </Link>
        </div>
      )}
    </AuthShell>
  );
}

function FooterLink({
  prompt,
  linkText,
  href,
}: {
  prompt: string;
  linkText: string;
  href: string;
}) {
  return (
    <p className="font-sans text-sm text-(--el-text)">
      {prompt}{' '}
      <Link
        href={href}
        className="font-medium text-(--el-link) hover:text-(--el-link-pressed) focus-visible:outline-none focus-visible:underline"
      >
        {linkText}
      </Link>
    </p>
  );
}

/**
 * Which message a failed credential sign-in shows (MOTIR-1167).
 *
 * ⚠️ THE DEFAULT IS UNIFIED ON PURPOSE, AND THE ONE BRANCH DOES NOT WEAKEN IT.
 * Every other failure collapses to the same "that password isn't right" copy so
 * the form enumerates nothing — an attacker must not learn from it whether an
 * address has an account. `ACCOUNT_SUSPENDED` is safe to distinguish because of
 * WHEN it is raised: the guard hangs off `session.create`, which runs only after
 * the credential has already verified, so the code reaches nobody who has not
 * just proved they own the account. There is nothing left to enumerate.
 *
 * And saying it is not a nicety. Without this branch the refusal renders as
 * "that password isn't right", which is FALSE — the password was right — so the
 * person resets a working password, gets in nowhere, and the suspension an
 * operator applied is invisible to the only person it happened to. Measured on
 * a live render before this branch existed.
 *
 * The operator's REASON is deliberately not here: it is written for other
 * operators, and `lib/auth/accountSuspension.ts` carries that argument.
 */
function signInErrorKey(error: unknown): 'accountSuspended' | 'wrongPassword' {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return code === 'ACCOUNT_SUSPENDED' ? 'accountSuspended' : 'wrongPassword';
}

/** The hand-off banner's value, per who vouches for the waiting app. */
function OAuthHandOff({ app }: { app: SignInOAuthApp }) {
  const t = useTranslations('oauthConsent');
  const { verification } = app;
  switch (verification.kind) {
    case 'domain':
      return t.rich('signIn.carriedValueVerified', {
        b: (chunks) => <b className="font-mono font-semibold break-all">{chunks}</b>,
        host: verification.host,
        app: app.name ?? t('unnamedApp'),
      });
    case 'self':
      // A self-registered app's name is its own claim; with none, the shipped
      // "This app" line says nothing it can't back.
      return app.name
        ? t('signIn.carriedValueUnverified', { app: app.name })
        : t('signIn.carriedValue', { app: t('unnamedApp') });
    case 'registered':
      return t('signIn.carriedValue', { app: app.name ?? t('unnamedApp') });
  }
}
