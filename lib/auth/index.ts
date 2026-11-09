import { cache } from 'react';
import { betterAuth, type Auth, type BetterAuthOptions } from 'better-auth';
import { isAPIError } from 'better-auth/api';
import { prismaAdapter } from '@better-auth/prisma-adapter';
import { passkey } from '@better-auth/passkey';
import { oauthProvider } from '@better-auth/oauth-provider';
import { cimd } from '@better-auth/cimd';
import { nextCookies } from 'better-auth/next-js';
import { deviceAuthorization } from 'better-auth/plugins';
import { twoFactor } from 'better-auth/plugins/two-factor';
import { headers } from 'next/headers';
import { db } from '@/lib/db';
import { resolveBaseUrl, resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import { sendAuthEmail } from '@/lib/auth/authMail';
import { assertAccountNotSuspended } from '@/lib/auth/accountSuspension';
import { workspacesService } from '@/lib/services/workspacesService';
import { twoFactorService } from '@/lib/services/twoFactorService';
import { legalAcceptanceService } from '@/lib/services/legalAcceptanceService';
import { resolveRecipientLocale } from '@/lib/services/emailRecipientLocale';
import { shouldUseSecureCookies } from '@/lib/e2eProdHarness';
import { applyStaffSession, type StaffSessionContext } from '@/lib/platform/staffSession';
import {
  CLI_CLIENT_ID,
  DEVICE_CODE_EXPIRES_IN,
  DEVICE_CODE_POLL_INTERVAL,
  DEVICE_VERIFICATION_PATH,
} from '@/lib/cliDevice/constants';
import {
  TWO_FACTOR_BACKUP_CODE_COUNT,
  TWO_FACTOR_ISSUER,
  TWO_FACTOR_OTP_ALLOWED_ATTEMPTS,
  TWO_FACTOR_OTP_DIGITS,
  TWO_FACTOR_OTP_PERIOD_MINUTES,
  TWO_FACTOR_TOTP_PERIOD_SECONDS,
  TWO_FACTOR_TRUST_DEVICE_MAX_AGE_SECONDS,
} from './twoFactorConfig';
import { PASSKEY_RESIDENT_KEY, PASSKEY_RP_NAME, PASSKEY_USER_VERIFICATION } from './passkeyConfig';
import { hash, verify } from './passwords';
import { createBetterAuthRateLimitStorage } from '@/lib/rateLimit/betterAuthStorage';
import { mcpOAuthPolicy } from './mcpOAuthPolicy';
import { localeSync } from './localeSync';
import { localeFromRequestHeaders } from '@/lib/i18n/seedLocale';
import { contentLanguageFromAcceptLanguage } from '@/lib/i18n/contentLanguage';
import { seedResourcesLazily } from './lazyResourceSeed';
import {
  CIMD_FETCH_POLICY,
  CIMD_REVALIDATION_INTERVAL,
  fetchClientMetadataDocument,
} from '@/lib/oauth/clientMetadataDocument';
import { CONSENT_REQUIRED_REFERENCE, currentConsentConnection } from '@/lib/oauth/consentContext';
import {
  mcpResourceUrl,
  OAUTH_CONSENT_PAGE,
  OAUTH_LOGIN_PAGE,
  OAUTH_SCOPES,
} from '@/lib/oauth/config';

// Better-Auth instance. Persistence is Postgres via Prisma; password hashing
// is argon2id (overriding Better-Auth's default scrypt) so the codebase has
// exactly one password-hashing primitive — see lib/auth/passwords.ts.
//
// Subtask 1.1.4 added Google OAuth as a peer sign-in method. The auto-link
// policy lives in Better-Auth's `account.accountLinking` config (trustedProviders:
// ['google']) — when a Google sign-in arrives with an email that matches an
// existing User, Better-Auth links the new Account row to that User instead
// of creating a duplicate. This is Story 1.1's decision (MOTIR.md "Current
// state"); the security trade-off (Google-compromise → account takeover) is
// acceptable for v1 because Google has already verified the email.
//
// Each Motir-planned project supplies its own Google Cloud OAuth credentials
// (per the planner-as-consumer principle, notes.html mistake #22): no shared
// defaults ship. Missing creds → requiredEnv throws at module load, surfacing
// the gap loudly instead of letting the Google button error mysteriously at
// click time.
//
// Password reset (Subtask 1.1.6) is wired below via
// emailAndPassword.sendResetPassword. Better-Auth mounts the request
// endpoint at /api/auth/request-password-reset and the confirm endpoint
// at /api/auth/reset-password automatically; reset tokens are stored in
// the existing Verification table (identifier = "reset-password:<token>",
// value = userId). No PasswordResetToken table is needed — see the
// schema's Verification docstring for the wider rationale.
//
// Email verification stays off in this Subtask; a later Subtask will flip
// requireEmailVerification on once the verification-email UX is designed.

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. See .env.example for the required auth env vars.`);
  }
  return value;
}

// ⚠️ THE OPTIONS ARE A NAMED, ANNOTATED CONST, AND THE ANNOTATION IS
// LOAD-BEARING (MOTIR-4293). Do not inline this object back into the
// `betterAuth(...)` call, and do not delete the annotation.
//
// The lib layer is a COMPOSITE TypeScript project now (`tsconfig.lib.json`): it emits
// `.d.ts` for the tests and scripts projects to consume, which is what takes
// the whole-repository type-check off the one-program heap cliff. A declaration
// can only NAME types the emitting file references, and Better-Auth's INFERRED
// instance type reaches three transitive packages this module does not import
// (`zod/v4/core`, `better-call`, `@simplewebauthn/server`). Left inferred, `tsc`
// answers TS2742 three times and emits NOTHING for this module — which surfaces
// downstream as `.tsout/app/lib/auth/index.d.ts has not been built` in 59 test
// files, nowhere near the cause.
//
// So both halves are written down out of types this file already imports:
//  · `authOptions` carries `BetterAuthOptions & { plugins: [...] }` — the
//    intersection keeps the object literal contextually typed (its hooks and
//    callbacks infer their parameters from it, so nothing becomes `any`) while
//    naming the plugin TUPLE, which is the part `Auth<O>` is invariant in;
//  · `auth` is then `Auth<typeof authOptions>` — one nameable type expression.
//
// The cost is real and small: `auth.options` now reads as `BetterAuthOptions`
// rather than as this literal, so a caller reaching into a specific hook sees
// its declared arity rather than ours (`tests/auto-workspace-on-signup.test.ts`
// is the one such caller). The alternative was for `pnpm typecheck` to keep
// needing `--max-old-space-size`.
export const authOptions: BetterAuthOptions & {
  plugins: [
    ReturnType<typeof deviceAuthorization>,
    ReturnType<typeof twoFactor>,
    ReturnType<typeof passkey>,
    ReturnType<typeof mcpOAuthPolicy>,
    ReturnType<typeof localeSync>,
    ReturnType<typeof oauthProvider>,
    ReturnType<typeof cimd>,
    ReturnType<typeof nextCookies>,
  ];
  // Named so `Auth<typeof authOptions>` infers the saved language onto the
  // session user (MOTIR-7743) — the annotation above would otherwise widen
  // `user` to `BetterAuthOptions['user']` and drop the field from the type.
  user: {
    additionalFields: {
      locale: { type: 'string'; required: false; input: false };
    };
  };
} = {
  database: prismaAdapter(db, { provider: 'postgresql' }),

  secret: requiredEnv('BETTER_AUTH_SECRET'),
  // baseURL is the canonical origin Better-Auth uses to build email-link
  // URLs and OAuth redirect URIs. It identifies the deployment to itself
  // but does NOT, on its own, establish which origins are allowed to call
  // the /api/auth/* endpoints — that's `trustedOrigins` below.
  //
  // It is supplied IN CODE from `resolveBaseUrl()`, which owns the whole
  // precedence (MOTIR_BASE_URL, else localhost — see lib/baseUrl.ts). This
  // module used to duplicate that chain inline, which is how the app grew two
  // answers to "what is my own origin"; nothing about Better-Auth depends on
  // the variable's NAME, so there is no reason to keep a second reader here.
  baseURL: resolveBaseUrl(),
  // trustedOrigins is the allowlist for cross-origin (and same-origin
  // with mismatched baseURL) requests to /api/auth/*. Without an explicit
  // list, Better-Auth defaults to [baseURL].
  //
  // It used to enumerate four Vercel-era URLs because a preview deployment was
  // reachable on a branch alias, a deployment-unique URL AND a custom domain at
  // once. The app is served on ONE origin, so the allowlist collapses to that
  // origin plus the dev origin. De-duplicated because locally the two are the
  // same string, and an allowlist that repeats itself invites the reader to
  // think one of the entries means something else.
  trustedOrigins: Array.from(new Set([resolveBaseUrl(), 'http://localhost:3000'])),

  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
    password: {
      hash,
      verify: ({ hash: stored, password }) => verify(password, stored),
    },
    // 1 hour matches Better-Auth's default; pinned explicitly so the AC
    // is visible in code review and so a future framework default change
    // can't silently widen our reset-token window.
    resetPasswordTokenExpiresIn: 3600,
    // Called by Better-Auth when /api/auth/request-password-reset
    // succeeds. `url` is the canonical link to land the user on the
    // new-password page; `token` is the single-use reset token.
    //
    // We ENQUEUE the send (Story 1.6.3) rather than calling the provider
    // inline: the actual delivery (slow / flaky) moves to the durable
    // `email.send` job with retries, and this hook returns as soon as the
    // event is published — Better-Auth's reset response no longer waits on
    // the email provider, and a provider outage surfaces in the jobs
    // dashboard (1.6.5) instead of being silently swallowed here.
    //
    //   - workspaceId: null — a password reset is identity-scoped, not
    //     workspace-scoped (the user may belong to many workspaces or none),
    //     so this is a deliberately cross-workspace / system email.
    //   - idempotencyKey: the single-use reset token — a retried request
    //     that re-fires the same token dedups to one delivery within
    //     the dedup window.
    //
    // The body still lives in lib/emailTemplates/passwordReset.tsx; the
    // template is rendered inside the job by emailService (per CLAUDE.md,
    // no email body strings in the wiring layer).
    // ⚠️ STRICT (MOTIR-3583) — a reset mail that cannot be QUEUED must not be
    // reported as sent. Better-Auth swallows what this hook throws
    // (`runInBackgroundOrAwait` is a bare try/catch) and answers
    // `{ status: true }` regardless, so the throw is not what corrects the
    // response: the POST wrapper below reads the per-request record
    // `sendAuthEmail` leaves and answers 503 instead. See
    // `lib/auth/authMail.ts`.
    sendResetPassword: async ({ user, url, token }) => {
      await sendAuthEmail({
        workspaceId: null,
        idempotencyKey: token,
        to: user.email,
        template: 'password-reset',
        data: {
          recipientName: user.name || 'there',
          resetUrl: url,
          // The account holder's saved language, never the requesting browser's.
          locale: await resolveRecipientLocale({ userId: user.id }),
        },
      });
    },
  },

  // Rate-limit configuration. Better-Auth's rate limiter keys requests by
  // client IP (see @better-auth/core's get-request-ip.ts). The Subtask AC
  // asks for "3 requests/hour per email" on password-reset; Better-Auth
  // can't bind a rule to a body field, only to a request path, so we
  // approximate it as "3/hour per IP for /request-password-reset". A
  // single attacker behind one IP can't enumerate; the small UX cost of
  // shared-NAT users hitting the limit is acceptable for v1. Note also
  // that `enabled` defaults to `true` only in production — we set it
  // explicitly so the limiter is active in dev and tests too.
  //
  // The path here is /request-password-reset (not /forget-password):
  // that's the canonical endpoint mounted by better-auth's (1.6.11, still on 1.7.7)
  // password.mjs route module.
  // PRODECT_FINDINGS #9: Better-Auth groups /sign-in, /sign-up,
  // /change-password, /change-email into ONE IP-keyed bucket (window 10s,
  // max 3). A multi-user E2E flow signs up two users from localhost (one IP)
  // inside that window, so the second /sign-up/email returns 429 and the spec
  // flakes. The durable fix is an explicit opt-in env flag, honored ONLY here
  // and set ONLY in playwright.config.ts's webServer.env — production never
  // sets it, so the limiter stays fully active in prod. The flag is opt-in
  // (default: limiter on) so a prod box with NODE_ENV unset can't accidentally
  // ship with rate limiting off.
  //
  // WHERE THE BUCKETS LIVE (MOTIR-8613). better-auth 1.7.7's
  // `dist/context/create-context.mjs` defaults the storage to
  // `options.rateLimit?.storage || (options.secondaryStorage ? "secondary-storage" : "memory")`
  // — with neither set, a module-level Map per process, so every limit was
  // `max × machines` on the Fly pool. `customStorage` is read before any of
  // those, and `lib/rateLimit/betterAuthStorage.ts` points it at the shared
  // Postgres counter every app-level limiter uses.
  rateLimit: {
    enabled: process.env['E2E_DISABLE_RATE_LIMIT'] !== '1',
    customStorage: createBetterAuthRateLimitStorage(),
    customRules: {
      '/request-password-reset': {
        window: 3600,
        max: 3,
      },
    },
  },

  // The person's saved interface language (Story MOTIR-7730 · MOTIR-7743) rides
  // on the session through Better-Auth's own seam for extra user columns, so a
  // signed-in render reads it from the session lookup it already pays for —
  // `i18n/request.ts` resolves the request's locale from it without a second
  // query. `input: false`: no sign-up or update-user BODY may set it. The writes
  // are the product's (the Settings choice and the sign-up seed), never a
  // client-supplied field.
  user: {
    additionalFields: {
      locale: { type: 'string', required: false, input: false },
    },
  },

  socialProviders: {
    google: {
      clientId: requiredEnv('GOOGLE_CLIENT_ID'),
      clientSecret: requiredEnv('GOOGLE_CLIENT_SECRET'),
    },
  },

  account: {
    accountLinking: {
      enabled: true,
      // When a sign-in via a trusted provider arrives with an email that
      // already exists on a local User, Better-Auth links the new Account
      // row to that User. Google is trusted because it verifies email
      // addresses before issuing tokens (the id_token's email_verified
      // claim is enforced upstream). Add new providers here only after
      // confirming the same.
      trustedProviders: ['google'],
      // Better-Auth's `requireLocalEmailVerified` defaults to `true`, which
      // gates linking on the EXISTING user.emailVerified column even when
      // the incoming provider is trusted (see better-auth's
      // oauth2/link-account.mjs line 22). Our email/password sign-up does
      // NOT set emailVerified=true (we have not yet wired the verification
      // UX), so leaving this default on would block the very flow
      // `trustedProviders: ['google']` was meant to enable: email-first
      // user later signing in with Google. Setting it to false defers the
      // verification gate to the provider's `userInfo.emailVerified` —
      // which for Google is enforced upstream before the id_token is
      // issued. Side benefit: better-auth then promotes the local user's
      // emailVerified to true on the linking sign-in (link-account.mjs
      // line 48), so subsequent flows see the user as verified.
      // The reverse direction (OAuth-first then email/password sign-in)
      // remains unsupported because OAuth-only users have no credential
      // Account row with a password hash; tracked in the planner-side
      // PRODECT_FINDINGS.md (lives in ../prodect_plan/ in this workspace).
      requireLocalEmailVerified: false,
    },
    // Refresh persisted access/refresh tokens on every sign-in so a
    // long-lived refresh token doesn't go stale. Default in Better-Auth,
    // pinned here for AC visibility.
    updateAccountOnSignIn: true,
  },

  // Better-Auth's default session cookie is already httpOnly + sameSite=lax
  // + secure-in-production. Pinning the explicit settings here keeps the AC
  // visible in code review and gives future env-specific overrides an
  // obvious home.
  advanced: {
    cookies: {
      session_token: {
        attributes: {
          httpOnly: true,
          sameSite: 'lax',
          // Secure in real production; NOT under the E2E production harness,
          // which drives a `next start` build over plain http://localhost — a
          // Secure cookie would never be returned there, breaking every
          // signed-in spec (MOTIR-1679). This is the "env-specific override"
          // the comment above anticipated.
          secure: shouldUseSecureCookies(),
        },
      },
    },
  },

  // Auto-create a default workspace whenever Better-Auth creates a User
  // (Subtask 1.2.4). This fires for BOTH signup paths that create a user:
  // email/password sign-up and Google new-user sign-up. The Google
  // *linking* path (an email-first user later signing in with Google) does
  // NOT create a user row, so this hook correctly does not fire and the
  // pre-existing workspace is preserved.
  //
  // BEST-EFFORT, NOT ATOMIC. In better-auth (1.6.11, re-read on 1.7.7) the `create.after` hook
  // runs via queueAfterTransactionHook — i.e. AFTER the user-insert
  // transaction has already committed (verified in
  // better-auth/dist/db/with-hooks.mjs; the planning card claimed it was
  // in-transaction, corrected in PRODECT_FINDINGS #6). So a throw here
  // cannot roll back the user; it would only turn an otherwise-successful
  // signup into a 500. We therefore swallow + log any failure. The real
  // correctness guarantee is the lazy self-heal:
  // workspacesService.ensureDefaultWorkspace, which the workspace-context
  // resolver calls when it finds a signed-in user with zero memberships
  // (lib/workspaces/middleware.ts). That backfill also future-proofs any
  // later signup path that bypasses this hook.
  databaseHooks: {
    // ⚠️ A SUSPENDED ACCOUNT CANNOT OPEN A SESSION (MOTIR-1167). Every way into
    // Motir — email + password, Google, the two-factor challenge, the RFC 8628
    // device grant behind `motir login` — ends here, and none of them shares an
    // endpoint with the others, so this hook is the only placement that cannot
    // be routed around by adding a sign-in path. The reasoning, and why it
    // THROWS rather than returning `false`, is in
    // `lib/auth/accountSuspension.ts`.
    session: {
      create: {
        before: async (session) => {
          await assertAccountNotSuspended(session.userId);
        },
        // ⚠️ SIGNING IN DOES NOT CANCEL A SCHEDULED ACCOUNT DELETION, AND
        // THERE IS DELIBERATELY NO `after` HOOK HERE (MOTIR-3742).
        //
        // MOTIR-3700 hung a `cancelDeletionOnSignIn` off `session.create.after`
        // and argued — correctly — that this is the ONE seam every sign-in path
        // funnels through. What that argument could not see is what the cancel
        // COMPOSED with: scheduling revokes every session, so the next thing the
        // reader does is sign in, and an auto-cancel there took the deletion
        // back before any page rendered. The two DRAWN cancel doors (MOTIR-3704:
        // the pane's scheduled state and the app-wide banner) were then
        // reachable only when the cancel itself had thrown, and somebody signing
        // in once to collect their export lost their deletion silently.
        //
        // So the cancel is now the deliberate act the design draws, and the
        // banner — mounted once in `app/(authed)/layout.tsx`, hence on every
        // authed page whichever door the reader came in through — is what gives
        // the placement guarantee the seam argument wanted.
        // `docs/decisions/account-deletion-cancel-path.md` is the record.
      },
    },
    user: {
      create: {
        // ⚠️ THE ACCOUNT LANGUAGE IS SEEDED IN THE INSERT ITSELF (Story
        // MOTIR-7730 · MOTIR-7747), from the language the signing-up request
        // resolves to — its NEXT_LOCALE choice, else the best Accept-Language
        // match, else English (`lib/i18n/seedLocale.ts`). In `before`, not
        // `after`, so it lands atomically with the row: no best-effort window
        // and no second write. A `create` hook fires only when a user row is
        // inserted — a new email sign-up or a new Google account — so signing
        // in, and Google LINKING onto an existing account, never reach it, and
        // it cannot overwrite a saved language. The second argument is
        // better-auth's endpoint context (`tryGetCurrentAuthEndpointContext()`
        // in `db/with-hooks.mjs` at 1.7.7): `ctx.headers` carries the request
        // headers on both paths (and `ctx.request.headers` on the route
        // handler). With no context — a server-side create such as a seed
        // script — `locale` stays null rather than guessing.
        before: async (user, ctx) => ({
          data: {
            ...user,
            locale: localeFromRequestHeaders(ctx?.headers ?? ctx?.request?.headers ?? null),
          },
        }),
        after: async (user, ctx) => {
          // ⚠️ THE LEGAL ACCEPTANCE IS RECORDED FIRST, AND IN ITS OWN
          // try/catch (Story 8.4 · Subtask MOTIR-1135).
          //
          // WHY HERE. This hook is the ONE seam both account-creating paths pass
          // through — email/password sign-up AND Google new-user sign-up — and
          // the Google path is the one that matters: `Continue with Google` sits
          // on the sign-up card's identity step and creates an account outright,
          // so nothing on the form's submit path ever runs for it. A capture
          // wired into the form would have recorded nothing for every Google
          // account, silently. (It is also why the notice itself now renders at
          // the card FOOT rather than inside the password step — same defect,
          // same fix, `design/auth/design-notes.md`.)
          //
          // WHY IT IS SAFE THAT THIS IS POST-COMMIT AND BEST-EFFORT. The comment
          // above records that better-auth runs `create.after` AFTER the
          // user-insert transaction commits, so a throw here cannot roll the user
          // back and would only 500 an otherwise-successful signup. The
          // acceptance therefore inherits the same self-healing arm the default
          // workspace does, and it has a better one: if this write is lost, the
          // re-consent gate finds no acceptance on the reader's very next
          // signed-in page load, holds them at the interstitial, and records it
          // there. A missed row degrades to one extra screen, never to a person
          // bound by terms with nothing on record.
          //
          // ⚠️ ITS OWN try/catch, not a shared one — the two writes are
          // independent, and a tenancy-provisioning failure must not take the
          // legal record with it (nor the reverse).
          try {
            await legalAcceptanceService.recordAcceptance(user.id);
          } catch (err) {
            console.error(
              `[auth] legal-acceptance record failed for user ${user.id}; ` +
                `the re-consent gate will ask on the next signed-in page load.`,
              err,
            );
          }

          try {
            // Story 6.10.4 — auto-provision the new account's tenancy: an
            // organization (an org of one / OPC) + a default workspace + the
            // owner memberships for both, atomically. provisionForNewUser is the
            // named entry for this (it delegates to createWorkspace's
            // mint-own-org branch).
            //
            // The minted org's CONTENT language comes from the browser's top
            // `Accept-Language` tag (Story MOTIR-7731 · MOTIR-8093): `zh` for a
            // Chinese browser, `en` for every other one. better-auth hands
            // `after` the same endpoint context `before` reads.
            const headers = ctx?.headers ?? ctx?.request?.headers ?? null;
            await workspacesService.provisionForNewUser({
              userId: user.id,
              userName: user.name,
              contentLanguage: contentLanguageFromAcceptLanguage(headers?.get('accept-language')),
            });
            // ⚠️ THE DEFAULT PROJECT IS **NOT** SEEDED HERE, AND THAT IS A
            // STRUCTURAL DECISION RATHER THAN AN OMISSION (MOTIR-4870).
            //
            // "You are always in a project" is enforced at the WORKSPACE tier
            // by `projectsService.ensureDefaultProject`, at two call sites: the
            // create-workspace action, and — the actual guarantee — the lazy
            // self-heal inside `getActiveProject`. A registering reader's very
            // next request resolves that context, so the project exists by the
            // time anything can look for it, which is exactly what this hook's
            // own best-effort contract promises for the workspace.
            //
            // Calling it HERE would import `projectsService` into this module,
            // and that closes an import CYCLE:
            //   lib/auth → projectsService → boardsService → workItemsService
            //   → assignableMembersService → lib/workspaces → lib/auth
            // Under it `@/lib/auth` is partially initialised when
            // `lib/workspaces` captures `getSession`, and a test that mocks
            // this module gets the real one — which surfaced as
            // `requireCompliantWorkspaceContext` answering 401 instead of 403
            // across eight Vitest shards. A dynamic import would hide the cycle
            // rather than remove it, and the eager seed buys nothing the
            // resolver does not already guarantee.
          } catch (err) {
            // Post-commit best-effort: do not rethrow (the user row is
            // already durably committed; rethrowing only 500s the signup
            // response). The lazy backfill recreates this on first
            // workspace-context resolution.
            console.error(
              `[auth] default-workspace creation failed for user ${user.id}; ` +
                `the lazy backfill will retry on next context resolution.`,
              err,
            );
          }
        },
      },
    },
  },

  // The nextCookies plugin makes Set-Cookie headers flow correctly through
  // Next.js Server Actions. Recommended for App Router.
  //
  // deviceAuthorization (Story MOTIR-1863 · Subtask MOTIR-1865) is the RFC 8628
  // state machine behind `motir login`: it mounts /device/code, /device/token,
  // GET /device, /device/approve and /device/deny under the existing /api/auth/*
  // handler and persists grants in the `DeviceCode` model. It is a PRIVATE
  // IMPLEMENTATION DETAIL — the CLI's contract is Motir's own /api/cli/device/*
  // (see lib/services/cliDeviceService.ts and docs/decisions/cli-login.md), because
  // the plugin's own /device/token completes into a SESSION and no bearer gate in
  // this repo accepts one. Only two of its endpoints are called from outside:
  // GET /api/auth/device?user_code=… (the claim, which stamps userId onto the row)
  // and POST /api/auth/device/deny — both from the /device page (MOTIR-1867).
  //
  // Config notes (all decided in the ADR):
  //   * verificationUri is RELATIVE, so buildVerificationUris resolves it against
  //     the baseURL chain above and a preview deployment prints its own URL.
  //   * expiresIn 15m (not the plugin's 30m default) — a shorter code lifetime is a
  //     smaller phishing window, which is the residual risk of choosing device code
  //     over loopback+PKCE.
  //   * validateClient pins client_id, so an unrelated caller cannot open grants.
  //   * NO generateUserCode override: the plugin's default charset is already
  //     ABCDEFGHJKLMNPQRSTUVWXYZ23456789 — free of 0/O/1/I/L.
  //   * NO rateLimit customRule for /device/token: the CLI polls this endpoint on a
  //     5s interval BY DESIGN, and the plugin's own per-grant `slow_down` throttle
  //     (lastPolledAt + pollingInterval) is the correct guard. An IP-keyed limiter
  //     here would break the normal flow, not an attack.
  plugins: [
    deviceAuthorization({
      verificationUri: DEVICE_VERIFICATION_PATH,
      expiresIn: DEVICE_CODE_EXPIRES_IN,
      interval: DEVICE_CODE_POLL_INTERVAL,
      validateClient: (clientId: string) => clientId === CLI_CLIENT_ID,
      // No `schema` override: Motir's DeviceCode model uses the plugin's field
      // names verbatim. (1.6.11 REQUIRED an empty `schema: {}` here — its options
      // parser declared the field without `.optional()`; 1.7 made it optional.)
      //
      // 1.7 split the OAuth provider's device grant into its own
      // `oauthDeviceAuthorization()` (with `oauthClientId` / `resources` columns).
      // That plugin is NOT this one, and Motir does not install it: `motir login`
      // completes into Motir's own CLI PAT (/api/cli/device/*), never an OAuth
      // token, so this plain plugin and its nine fields are unchanged (MOTIR-7171).
    }),
    // twoFactor (Story MOTIR-1213 · Subtask MOTIR-1217) is Better-Auth's own
    // 2FA plugin. It mounts /two-factor/enable, /two-factor/disable,
    // /two-factor/verify-totp, /two-factor/send-otp, /two-factor/verify-otp,
    // /two-factor/generate-backup-codes and /two-factor/verify-backup-code
    // under the existing /api/auth/* handler, adds `user.twoFactorEnabled`, and
    // persists the enrolment in the `two_factor` model.
    //
    // WHY THE PLUGIN AND NOT OUR OWN. TOTP, emailed OTP and recovery codes are
    // one mechanism with one enrolment record, and every part of it — the
    // RFC-6238 step window, the constant-time compare, the interception of the
    // password step, the short-lived two-factor cookie — is cryptographic code
    // that is wrong in ways nothing in this repo would catch. So this subtask is
    // wiring, not crypto.
    //
    // ⚠️ RECOVERY CODES ARE ENCRYPTED, NOT HASHED — and that is FORCED, not
    // chosen. The card asks for "backup codes = 10, hashed at rest".
    // `BackupCodeOptions.storeBackupCodes` offers exactly
    // `'plain' | 'encrypted' | { encrypt, decrypt }` — there is no hashed arm,
    // because the whole code SET lives in one column and verifying a code means
    // decoding that column and searching it, then rewriting it without the code
    // just spent. A hash cannot be searched that way. `'encrypted'` is the
    // strongest thing the plugin has (AES via BETTER_AUTH_SECRET), and it is
    // also the plugin's default; pinned explicitly so the deviation is visible
    // in review rather than inferred from silence. The EMAILED OTP does support
    // hashing, and takes it below.
    //
    // ⚠️ NO TRUSTED-DEVICE TABLE. The card asks us to decide whether "remember
    // this device" needs storage of its own; it does not. The plugin writes a
    // `trust-device-<random>` row into the EXISTING `verification` table with an
    // expiry and hands the browser a signed `trust_device` cookie
    // (plugins/two-factor/verify-two-factor.mjs), so revoking a device is
    // deleting a verification row — a table that already exists, with a sweep
    // that already expires it. The decision is recorded on the `TwoFactor` model
    // in schema.prisma too, since that is where a reader looks for it.
    //
    // Every option below is either the plugin's default pinned for review
    // visibility or a value the story's own acceptance recipe names; the numbers
    // live in ./twoFactorConfig so the UI can state them without a second copy.
    twoFactor({
      issuer: TWO_FACTOR_ISSUER,
      totpOptions: {
        digits: TWO_FACTOR_OTP_DIGITS,
        period: TWO_FACTOR_TOTP_PERIOD_SECONDS,
      },
      backupCodeOptions: {
        amount: TWO_FACTOR_BACKUP_CODE_COUNT,
        storeBackupCodes: 'encrypted',
      },
      otpOptions: {
        digits: TWO_FACTOR_OTP_DIGITS,
        period: TWO_FACTOR_OTP_PERIOD_MINUTES,
        allowedAttempts: TWO_FACTOR_OTP_ALLOWED_ATTEMPTS,
        // Unlike the recovery codes above, the emailed code IS hashed at rest:
        // it is a single value compared once, so nothing needs to read it back.
        storeOTP: 'hashed',
        // The plugin has already generated and persisted the hashed challenge
        // by the time this runs, so the send is a post-commit side effect in
        // its ordinary shape. `dispatchOtpEmail` ENQUEUES onto the durable
        // `email.send` job (MOTIR-1218) rather than calling the provider, so a
        // slow or down provider never touches the request the user is waiting
        // on — exactly as sendResetPassword does above.
        //
        // The composition lives in the SERVICE, not here: CLAUDE.md keeps email
        // logic out of the wiring layer, and a hook buried in a config literal
        // is a hook no test can reach.
        sendOTP: async ({ user, otp }) => {
          await twoFactorService.dispatchOtpEmail({
            userId: user.id,
            email: user.email,
            name: user.name,
            otp,
          });
        },
      },
      // ⚠️ TRUE, AND IT IS NOT A RELAXATION — read `shouldRequirePassword` before
      // changing it. Every 2FA MANAGEMENT action (enable, disable, regenerate
      // recovery codes) is password-gated, and the gate is:
      //
      //   if (!allowPasswordless) return true;                       // ← unconditional
      //   return Boolean(credentialAccount with a password);          // ← conditional
      //
      // So the DEFAULT (`false`) demands a password from EVERY user — including
      // one who has never had one. Motir ships Google as a peer sign-in method
      // with `trustedProviders: ['google']` above, so an account whose only
      // `Account` row is `providerId: 'google'` is an ordinary Motir account, not
      // an edge case (`design/settings/design-notes.md` treats the
      // credential-vs-OAuth-only branch as first-class for the Profile pane). For
      // that user `validatePassword` returns false unconditionally — no
      // credential account, no stored hash — so `enableTwoFactor` answers
      // `INVALID_PASSWORD` for a password they were never asked to set, and
      // there is no wording that could explain it. They could not turn 2FA on at
      // all.
      //
      // `true` makes the gate CONDITIONAL, which is strictly stronger than what
      // it replaces: a user WITH a password is still asked for it on all three
      // actions (the plugin's own docstring — "password is still required if a
      // credential account exists"), and a user without one stops being locked
      // out of the feature. Their re-auth is the session itself; Better-Auth
      // offers no OAuth step-up to reach for, and demanding a nonexistent
      // password is not a security control, it is an outage.
      allowPasswordless: true,
      // FALSE, deliberately (and it is the default): enabling 2FA hands back a
      // TOTP URI and the recovery codes but leaves `twoFactorEnabled` off until
      // a code generated from that secret is accepted. That is the
      // confirm-before-enabling step the story's recipe describes, and it is
      // what stops a mis-scanned QR from locking a user out of their own
      // account.
      skipVerificationOnEnable: false,
      // 30 days — the number the story's acceptance recipe names for "don't ask
      // again on this device". Also the plugin's default; pinned so the copy and
      // the cookie cannot drift apart.
      trustDeviceMaxAge: TWO_FACTOR_TRUST_DEVICE_MAX_AGE_SECONDS,
      // OFF, to keep the 1.7 upgrade a library move (MOTIR-7171). 1.7 added an
      // account-level lockout, ON by default: ten consecutive failed codes lock
      // the challenge for fifteen minutes. That is a product decision with copy
      // of its own (the challenge would have to explain the lock), not something
      // a dependency bump should switch on silently. 1.6.11 had no such lock, so
      // `false` is exactly the behaviour Motir shipped; the plugin's own limiter
      // on /two-factor/* (3 per 10 s) still bounds guessing.
      accountLockout: { enabled: false },
    }),
    // passkey (Story MOTIR-1214 · Subtask MOTIR-3610) is Better-Auth's WebAuthn
    // plugin, shipped as its own package rather than a `better-auth/plugins/*`
    // subpath. It mounts /passkey/generate-register-options,
    // /passkey/verify-registration, /passkey/generate-authenticate-options,
    // /passkey/verify-authentication, /passkey/list-user-passkeys,
    // /passkey/update-passkey and /passkey/delete-passkey under the existing
    // /api/auth/* handler, and persists credentials in the `passkey` model.
    //
    // ⚠️ A PASSKEY IS A PRIMARY CREDENTIAL, NOT A STEP INSIDE THE 2FA CHALLENGE.
    // `verifyPasskeyAuthentication` mints a session directly (which is why its
    // error set carries UNABLE_TO_CREATE_SESSION), so a passkey sign-in never
    // answers `{ twoFactorRedirect: true }` and never reaches the `twoFactor`
    // plugin's challenge above. That is why the affordance MOTIR-3613 adds sits
    // on the sign-in card's EMAIL step beside the Google button, and not in the
    // challenge screen — and it is correct product shape as well as correct
    // wiring: a UV-required credential is already two factors, so demanding a
    // second one after it would be theatre.
    //
    // NO CHALLENGE TABLE. The plugin keeps the WebAuthn challenge in a cookie
    // (`advanced.webAuthnChallengeCookie`, default `better-auth-passkey`) with a
    // hard-coded 300-second life, so there is nothing here to store, expire or
    // sweep. `PASSKEY_CHALLENGE_TTL_*` in ./passkeyConfig mirrors that number for
    // the panes, which have to explain a lapsed challenge in the user's units.
    //
    // NO DIRECT @simplewebauthn DEPENDENCY. `@simplewebauthn/server` and
    // `/browser` are the plugin's OWN dependencies; adding an entry for either to
    // package.json would pin a second copy against the one the plugin resolves.
    passkey({
      // Derived from lib/baseUrl.ts — the ONE module that owns the app's origin
      // — so `app.motir.co` in production and `localhost` in dev and tests fall
      // out of the same value Better-Auth's own `baseURL` above is built from. A
      // literal here, or a second env var, would be a second answer to a question
      // that module exists to answer once. `rpID` is the bare HOSTNAME (no
      // scheme, no port) because that is what the WebAuthn relying-party id is.
      rpID: new URL(resolveBaseUrl()).hostname,
      // What the operating system's own passkey prompt shows above the
      // fingerprint reader.
      rpName: PASSKEY_RP_NAME,
      // The full origin, trailing slash trimmed — the plugin's own docstring says
      // "do NOT include any trailing /", and `resolveBaseUrlTrimmed()` is exactly
      // that guarantee rather than a hope about how the secret was typed.
      origin: resolveBaseUrlTrimmed(),
      // ⚠️ `userVerification` MUST BE SET — this is the load-bearing line of the
      // whole registration. SimpleWebAuthn defaults to `'preferred'`, which
      // accepts an assertion the authenticator produced with no PIN, no
      // fingerprint and no face: possession only, ONE factor. `'required'` makes
      // the credential multi-factor on its own (NIST SP 800-63B), which is what
      // lets Story 8.13 (MOTIR-1215) count `passkey` towards a require-2FA
      // policy. The values live in ./passkeyConfig so the pane can state them.
      authenticatorSelection: {
        userVerification: PASSKEY_USER_VERIFICATION,
        residentKey: PASSKEY_RESIDENT_KEY,
      },
    }),
    // ── Motir as an OAuth 2.1 authorization server for its MCP ───────────────
    // (Story MOTIR-6973 · Subtask MOTIR-6982). Claude's connector and any other
    // MCP client discover it from `/.well-known/oauth-protected-resource`,
    // register themselves (RFC 7591), and run the authorization-code grant with
    // PKCE to get a token for `<base>/api/mcp`. It is the SUPPORTED package —
    // Better-Auth's own `oidc-provider` and `mcp` plugins are deprecated in its
    // favour — and it shares this instance's sessions, so a person signs in with
    // whatever they already use: password, Google, 2FA, passkey.
    //
    // The policy plugin runs FIRST: it refuses a redirect Motir will not honour
    // at registration and a missing or foreign `resource` at authorize, neither
    // of which the provider checks (`./mcpOAuthPolicy.ts`).
    mcpOAuthPolicy(),
    // Sign-in brings this browser's NEXT_LOCALE in line with the saved account
    // language (MOTIR-7747) — `lib/auth/localeSync.ts`.
    localeSync(),
    // Seeds the MCP resource on first use, not at import (`./lazyResourceSeed.ts`).
    seedResourcesLazily(
      oauthProvider({
        loginPage: OAUTH_LOGIN_PAGE,
        consentPage: OAUTH_CONSENT_PAGE,
        // The consent decision's CONNECTION (MOTIR-6983). Every consent row, code,
        // access token and refresh token carries the id of the `api_token` row the
        // person approved, and the MCP gate resolves a bearer through it to that
        // row's workspace, project and grant. The id comes from the approval in
        // progress (`lib/oauth/consentContext.ts`); outside one it is a reference no
        // consent carries, so every authorization goes to the consent screen, where
        // the workspace is chosen. `shouldRedirect` is false: there is no step
        // between signing in and consenting — the workspace picker IS the consent.
        postLogin: {
          page: OAUTH_CONSENT_PAGE,
          shouldRedirect: () => false,
          consentReferenceId: () => currentConsentConnection() ?? CONSENT_REQUIRED_REFERENCE,
        },
        scopes: [...OAUTH_SCOPES],
        // The only protected resource a token may be minted for (RFC 8707). 1.7
        // models resources as rows (`oauth_resource`), seeded at boot from this list
        // — it replaces 1.6.11's `validAudiences`, which 1.7 removed (and which,
        // because the factory's options are generic, would now be IGNORED rather
        // than refused by the type checker). The provider refuses a `resource` at
        // authorize or token that names no enabled row; `mcpOAuthPolicy()` still
        // REQUIRES one at authorize, which the provider does not (MOTIR-7171).
        //
        // The OBJECT form, not the bare string, for one reason: the string form
        // seeds `allowedScopes: null` ("inherit"), and Prisma refuses a null for a
        // list column. Naming the full scope set is the same policy — every scope
        // Motir offers is one the MCP accepts.
        resources: [
          { identifier: mcpResourceUrl(), name: 'Motir MCP', allowedScopes: [...OAUTH_SCOPES] },
        ],
        // OFF, deliberately. Its 1.7 default (`true`) demands an
        // `oauth_client_resource` link per client per resource, and every client
        // registered on 1.6.11 has none, so each existing connection's next refresh
        // would be refused. With exactly one resource, "every client may request
        // it" IS Motir's policy — the same one `validAudiences` expressed.
        enforcePerClientResources: false,
        grantTypes: ['authorization_code', 'refresh_token'],
        // RFC 7591 dynamic registration, unauthenticated: an MCP client registers
        // before anyone has signed in. Unauthenticated registration forces
        // `token_endpoint_auth_method: none` — public clients only — so there is
        // no client secret to leak and PKCE is always required.
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        // OPAQUE tokens, stored hashed in `oauth_access_token` /
        // `oauth_refresh_token`. Revocation is a row the MCP gate no longer finds,
        // and nothing needs a signing key — so no JWKS, and no new secret to
        // provision. It also means no OpenID `id_token`: Motir is not offered as a
        // login provider for other sites.
        disableJwtPlugin: true,
        // Registration and token are limited on the SHARED counter instead, per IP
        // (`lib/rateLimit/authGuard.ts`). The provider's own defaults (5 and 20 a
        // minute) are per-process and sized for one person — claude.ai registers
        // and refreshes for all of its users from a handful of egress addresses.
        rateLimit: { register: false, token: false },
        // (1.6.11's `silenceWarnings: { oauthAuthServerConfig: true }` is gone: 1.7
        // removed the option along with the warning it silenced.)
      }),
    ),
    // Client ID Metadata Documents (MOTIR-7173): a client may name itself by an
    // HTTPS URL, whose document is fetched, validated and recorded as a client
    // (`clientDiscoveryId: 'cimd'`). AFTER the provider, which its `init`
    // extends. Its discovery also advertises `client_id_metadata_document_
    // supported`, the flag Claude reads before using its published identity.
    // DCR stays open beside it for every other client.
    cimd({
      // The plugin's hardened node transport, behind a seam tests stub
      // (`lib/oauth/clientMetadataDocument.ts` says what it guarantees).
      fetchClientMetadataResource: fetchClientMetadataDocument,
      // MCP 2026-07-28 pins CIMD draft-00, which requires `client_name` and
      // `redirect_uris` — both of which the consent screen needs.
      metadataProfile: 'mcp-2026-07-28',
      metadataRevalidationInterval: CIMD_REVALIDATION_INTERVAL,
      metadataFetchPolicy: CIMD_FETCH_POLICY,
    }),
    // LAST, as Better-Auth requires of a cookie integration: it forwards the
    // `Set-Cookie` headers of every `after` hook that runs before it, and the
    // OAuth provider is the first plugin here to declare one (MOTIR-6982).
    nextCookies(),
  ],
};

export const auth: Auth<typeof authOptions> = betterAuth(authOptions);

/**
 * Server-side helper for reading the current session from a React Server
 * Component, Route Handler, or Server Action.
 *
 * Returns `null` when there is no active session. Returns the
 * `{ session, user }` object otherwise — shape is whatever Better-Auth's
 * `auth.api.getSession` returns for the current config.
 *
 * Usage:
 *   const session = await getSession();
 *   if (!session) redirect('/sign-in');
 *
 * ── Why this is wrapped in React `cache()` (MOTIR-2453) ─────────────────────
 *
 * An authenticated page render used to validate the session FOUR times, and a
 * `/dashboard` render five: `app/layout.tsx` (the applied appearance, 7.3.61),
 * `app/(authed)/layout.tsx` (the enforcement point + the shell's menus),
 * `getWorkspaceContext()` inside that layout, and the page's own read. Every
 * one of them was a separate database round-trip on the hottest path in the
 * product, because nothing deduped them: this was a plain `async function`,
 * so React's per-request memoisation did not apply.
 *
 * `cache()` is per-RENDER-PASS memoisation and nothing else, so it costs no
 * behaviour: the first caller in a render pays the lookup, the rest read the
 * same promise, and a REVOKED session is still rejected on the very next
 * request. Route handlers and Server Actions are not part of a page render, so
 * they keep their own lookup — correct, not a gap: each is its own request and
 * must re-validate. `cache()` is also inert outside a React server render (it
 * calls straight through), so `middleware`/`proxy.ts` are unaffected.
 *
 * ⚠️ Better-Auth's `session.cookieCache` was CONSIDERED AND REJECTED. It would
 * remove the round-trip more broadly by trusting a signed copy of the session
 * carried in the cookie, but it buys that with a window — up to its `maxAge` —
 * in which a REVOKED session still authenticates. Sign-out, a removed
 * workspace member and an admin revoking access are all supposed to take
 * effect immediately, and no `maxAge` short enough to preserve that saves a
 * meaningful number of round-trips once `cache()` has collapsed the duplicates
 * within a render. So the redundancy is removed and the security property is
 * kept whole. (Note it is OFF here by Better-Auth's own default, not by
 * omission: `better-auth/dist/context/create-context.mjs` enables it only
 * under `if (!options.database)`, and this instance passes `database:
 * prismaAdapter(db, …)`.) Do not turn it on without re-arguing that trade.
 *
 * Measured, not asserted from this comment: `tests/auth/session-request-memo.test.ts`
 * renders a three-deep server-component tree through the real RSC renderer and
 * counts calls to `auth.api.getSession` — 1 through this helper, 3 for the same
 * tree calling Better-Auth directly (the control that proves the harness can
 * see duplicates at all).
 */
export const getSession = cache(async () => readSession(await headers()));

/**
 * The session could not be READ — the database did not answer — as opposed to
 * there being no session. `code` is what a route answers with (a 503, see
 * `requireCompliantSession`), and `cause` is Better-Auth's own error.
 */
export class SessionUnavailableError extends Error {
  readonly code = 'SESSION_UNAVAILABLE';

  constructor(cause: unknown) {
    super('The session could not be read: the database did not answer.', { cause });
    this.name = 'SessionUnavailableError';
  }
}

/** One retry, on a fresh pooled connection — the attempt count, not a retry count. */
const SESSION_READ_ATTEMPTS = 2;
const SESSION_READ_RETRY_DELAY_MS = 100;

/**
 * `auth.api.getSession` for explicit request headers, with its two THROWS
 * given their meaning (MOTIR-5864). Every session read in the app goes through
 * here — `getSession()` above for the `next/headers` context, and
 * `resolveWorkspaceContext` for a handler holding a `Request`.
 *
 * ⚠️ BETTER-AUTH'S `getSession` DOES NOT RETURN `null` FOR EVERY FAILURE. Its
 * route body catches ANY non-API error — a dropped connection on the session
 * read included — and re-throws it as `APIError(INTERNAL_SERVER_ERROR,
 * "Failed to get session")` (`better-auth/dist/api/routes/session.mjs`). So a
 * `P1017` / `ECONNRESET` on `prisma.session.findFirst()` left every caller by
 * THROWING, past its own no-session arm: fifteen unhandled 500s on the bell's
 * unread-count poll, 2026-08-30 → 2026-09-20 (Sentry MOTIR-CORE-9), each with
 * that Prisma error one breadcrumb earlier.
 *
 *   · a 5xx `APIError` is the DATABASE, not the person. It is retried once —
 *     `pg` discards the broken connection, so the second read takes a fresh
 *     one — and if that fails too it becomes `SessionUnavailableError`, which
 *     the route gates answer as a handled 503.
 *   · the 401 `APIError` is Better-Auth's OTHER `FAILED_TO_GET_SESSION`: the
 *     session row was deleted while it was being refreshed (a sign-out or a
 *     revoke racing the request). That person HAS no session, so it is `null`.
 *   · anything else is not a session-read failure this knows how to name, and
 *     is re-thrown untouched.
 */
export async function readOperatorSession(requestHeaders: Headers) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= SESSION_READ_ATTEMPTS; attempt++) {
    try {
      return await auth.api.getSession({ headers: requestHeaders });
    } catch (error) {
      if (!isAPIError(error)) throw error;
      if (error.statusCode === 401) return null;
      if (error.statusCode < 500) throw error;
      lastError = error;
    }
    if (attempt < SESSION_READ_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, SESSION_READ_RETRY_DELAY_MS));
    }
  }
  throw new SessionUnavailableError(lastError);
}

/** Better-Auth's session for the current config, signed in. */
type SignedInSession = NonNullable<Awaited<ReturnType<typeof readOperatorSession>>>;

/**
 * The session the app acts as. Ordinarily Better-Auth's own; inside a staff
 * "View as" session (MOTIR-749) it is the TARGET's identity in the same shape,
 * with `impersonation` carrying the session and the operator's own identity
 * (who is really there, for attribution and for the banner).
 */
export type AppSession = SignedInSession & { impersonation?: StaffSessionContext };

/**
 * ⚠️ STAFF SESSIONS ARE LAYERED HERE (Story 10.3 · MOTIR-749). This is the one
 * function every session read passes through, so it is where a platform
 * superadmin's "View as" session is honoured and enforced: when the
 * staff-session cookie is present, `applyStaffSession`
 * (`lib/platform/staffSession.ts`) resolves it against the operator's own
 * session read above and answers the TARGET's identity (active), or `null`
 * (ended, expired, revoked — fail closed until the cookie is cleared). A
 * mutating request in a READ-ONLY session throws `ImpersonationReadOnlyError`
 * from here, before any service runs; one in a FULL session is audited before
 * it runs. `readOperatorSession` above is the raw read, for the console and the
 * staff-session doors only.
 *
 * @param options.method the request's HTTP method, when the caller holds the
 *   `Request` — the strongest "is this a write?" signal the gate has.
 */
export async function readSession(
  requestHeaders: Headers,
  options: { method?: string } = {},
): Promise<AppSession | null> {
  const raw = await readOperatorSession(requestHeaders);
  if (!raw) return null;
  const gate = await applyStaffSession(raw, requestHeaders, options.method ?? null);
  if (gate.kind === 'none') return gate.session;
  if (gate.kind === 'ended') return null;
  return { ...gate.session, impersonation: gate.context };
}
