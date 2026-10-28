# Authentication and multi-business ownership

All previous owner-facing Android requests now require
`Authorization: Bearer <access_token>`, including Business creation, profile,
settings, working hours, Catalog, Categories, Products, Variants, Inventory and
every Excel Import route. Registration, login, refresh, token-based logout,
forgot-password and reset-password are public credential/token operations. No health or
development controller exists in this checkout. A global guard denies new routes
without an explicit access policy.

## Registration and login

`POST /auth/register` returns 201; `POST /auth/login` returns 200. Both accept only:

```json
{
  "email": "owner@example.com",
  "password": "SecurePassword123!"
}
```

Email is trimmed and lowercased, ASCII only, valid email syntax, maximum 254
characters. Internationalized addresses are unsupported. A database CHECK rejects
unnormalized email and whitespace; the unique index arbitrates concurrent
registrations. Duplicate registration returns 409 EMAIL_UNAVAILABLE, so
registration reveals email availability. Login returns identical 401
INVALID_CREDENTIALS errors for unknown email and incorrect password. Unknown
users still incur Argon2id verification against a random startup-generated hash.

Registration passwords contain 12–128 UTF-16 code units and at least one ASCII
lowercase letter, uppercase letter and digit. Spaces and symbols are allowed.
Passwords are never trimmed/normalized. Login accepts 1–128 code units for generic
credential failures. Unknown JSON fields, including role, userId, businessId,
ownerId and passwordHash, are rejected.

Both operations issue a session:

```json
{
  "user": {
    "id": "f6bc7287-3285-4e19-a819-459c41f0a138",
    "email": "owner@example.com"
  },
  "accessToken": "<signed-access-token>",
  "refreshToken": "<opaque-refresh-token>",
  "tokenType": "Bearer",
  "expiresIn": 900,
  "refreshExpiresAt": "2026-11-26T12:00:00.000Z"
}
```

Passwords use Argon2id with random salts, 64 MiB memory, three iterations and
parallelism one. Hashes are never returned. Do not log request bodies, passwords,
hashes or Authorization headers in the backend, proxy or Android diagnostics.

## Tokens and configuration

Access tokens expire after **15 minutes**. Validation requires HS256, signature,
issuer, audience, expiration, maximum age, UUID subject and issued/expiry
timestamps. Payload contains only sub, sid (session family), ver (auth version),
iat, exp, iss and aud. Every protected request checks the session and auth version
against the database. It contains no
business selection, password or authoritative membership role.

Required environment variables, with no signing defaults:

```text
JWT_SECRET=<cryptographically random secret of at least 32 UTF-8 bytes>
JWT_ISSUER=brandora
JWT_AUDIENCE=brandora-android
```

Generate at least 32 random bytes securely and encode as base64. Store the key in
deployment secrets, never Git. Missing/short configuration prevents startup. All
instances need identical configuration; key rotation invalidates existing JWTs.

Android must use Keystore-backed encrypted storage for both tokens, send them only
over HTTPS, and never log tokens or reset links. Never send a refresh token in
ordinary Business/Catalog/Inventory/Import requests.

## Refresh sessions and logout

Registration and login both create a device session. Refresh tokens are opaque
random secrets with 256 bits of secret entropy, not JWTs. Only SHA-256 digests are
stored. One session works across every Business accessible to its User.

`POST /auth/refresh` accepts only `{ "refreshToken": "<opaque-token>" }` and
returns 200 with the same session response shape as login, including replacement
access and refresh tokens. Each token can rotate only once, transactionally under
the User row lock. The session's absolute expiration is **30 days after login**;
refresh never extends it. At 1,000 rotations, the session is revoked and login is
required. There are no per-refresh database rows: each session retains at most
1,000 consumed digests for replay detection.

Presenting a previously consumed token revokes its entire family. A simultaneous
duplicate refresh produces one 200 and one 401; the replay revokes even the
winner's newly returned tokens. A random incorrect token cannot revoke a family
merely by knowing its identifier. There are at most ten device slots per User.
New login reuses a revoked/expired slot, or evicts the least recently
login/refreshed slot when all ten are active, with a new random family identifier.
No other Business memberships or User data are changed.

Android must implement **single-flight refresh**: queue requests behind one
refresh operation, atomically persist its two replacement tokens, then retry each
request at most once. After a lost/ambiguous refresh response, do not blindly
retry the old refresh token: require login, because it may already be consumed.
Do not automatically retry non-idempotent writes after an unrelated network timeout.
After refresh expiry/replay/revocation, clear credentials and log in again.

`POST /auth/logout` accepts `{ "refreshToken": "<opaque-token>" }`, does not
require an access token, and returns 204. It revokes only that token's family;
unknown well-formed tokens also return 204. Malformed tokens return 400. The
refresh token is the credential for this public operation. Delete local tokens
after logout. No arbitrary userId/sessionId is accepted.

`POST /auth/logout-all` requires the access Bearer token and an empty JSON body
`{}`. It returns 204, revokes all of the current User's refresh sessions, and
increments authVersion. Logout, logout-all, replay and password reset invalidate
access tokens on the **next protected request**, because the guard checks current
session/version state. Already-running operations are not cancelled. Repeating
logout-all with its now-invalid access token returns 401.

## Forgot and reset password

`POST /auth/forgot-password` accepts only `{ "email": "owner@example.com" }`.
With configured email delivery it returns 200 for known and unknown addresses:

```json
{
  "message": "If the account exists, a password reset has been requested. Check your email; delivery may be delayed or unavailable."
}
```

No reset token, User ID or delivery result is returned. Normal responses have a
three-second minimum duration to reduce known/unknown timing differences; this
is practical padding, not a formal constant-time guarantee. The random reset
token expires in **15 minutes**. Only its SHA-256 digest is stored, in one reusable
row per User. A newer request invalidates the previous token. Delivery failures
are logged without credentials/tokens, marked FAILED and consumed in the DB;
the public response stays generic to avoid enumeration. The response is not a
delivery confirmation.

`POST /auth/reset-password` accepts:

```json
{
  "token": "<reset-token-from-email-link>",
  "newPassword": "NewSecurePassword123!"
}
```

The registration password policy applies unchanged. Success returns 204, atomically
consumes the token, writes a new Argon2id hash, increments authVersion and revokes
all refresh sessions. Concurrent reuse allows exactly one success. Expired,
consumed, superseded and invalid tokens return 400 AUTH_RESET_INVALID. Login with
the new password is required afterward. Password/ownership data is never reset
or reassigned by any other endpoint.

Email is disabled by default. Configure approved transactional SMTP credentials
before enabling it. Production requires a verified sending domain; Resend's
restricted development sender is described below.

```text
AUTH_EMAIL_MODE=smtp
AUTH_RESET_URL=https://<your-verified-app-link-domain>/auth/reset-password
SMTP_HOST=<provider-host>
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=<provider-user>
SMTP_PASSWORD=<deployment-secret>
SMTP_FROM=<verified-brandora-sender>
```

Port 587 requires STARTTLS; port 465 uses SMTP_SECURE=true. TLS certificate
validation cannot be disabled by these settings. The transport has bounded
timeouts and a 2.5-second send deadline. No actual third-party email is sent by
tests: they inject a controlled mailer. Live SMTP deliverability remains a
deployment configuration/verification requirement.

Without valid configuration, forgot-password returns the same 503
AUTH_EMAIL_UNAVAILABLE for all addresses before account lookup. It never returns
a development reset token or pretends email was delivered.

Android must configure a verified HTTPS App Link for AUTH_RESET_URL's exact
domain/path. Email links append `#token=<opaque-reset-token>`; read the fragment,
then POST the token and new password as JSON. Fragments keep tokens out of normal
HTTP access logs. Disable link tracking and redact complete reset links in email
and mobile diagnostics. A web fallback must use no-referrer and never log the
fragment or include it in analytics. Plain HTTP and custom-scheme reset URLs are
not accepted.

### Resend SMTP development setup (owner action; no email sent by setup)

The existing environment names are `AUTH_EMAIL_MODE`, `AUTH_RESET_URL`,
`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD` and
`SMTP_FROM`. There is no `RESEND_API_KEY` or recipient environment setting in this
implementation. The forgot-password request's registered email is the recipient.

Revoke the previously exposed Resend key in the Resend dashboard. Treat it as
compromised even if it still works. Create a new sending key and enter it privately
into the local process environment as `SMTP_PASSWORD`; never paste it into chat,
source files, shell command history, screenshots or logs. The repository example
and commands contain no key. This setup does not alter the local `.env` or any
Resend account settings automatically.

Use the following non-secret local settings and inject the new password separately:

```dotenv
AUTH_EMAIL_MODE=smtp
AUTH_RESET_URL=https://reset.example.invalid/auth/reset-password
SMTP_HOST=smtp.resend.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=resend
SMTP_FROM=onboarding@resend.dev
# SMTP_PASSWORD must be supplied privately as a local environment variable.
```

The `.env.example` keeps `AUTH_EMAIL_MODE=disabled` and `SMTP_PASSWORD` empty.
Port 465 connects with implicit TLS (`secure: true`); certificate validation stays
enabled. No credentials, certificate bypass, SMTP debug logging or provider SDK
are added to source. See [Resend SMTP settings](https://resend.com/docs/send-with-smtp).

No custom **sending** domain is needed for this development test: Resend restricts
`onboarding@resend.dev` to the email associated with the Resend account. Register
that same address as a User in the disposable local Brandora database. Do not try
other recipients or add a hardcoded recipient override to the backend. Sending
to other users requires a verified domain and an appropriate sender. See
[Resend's development-domain restriction](https://resend.com/docs/knowledge-base/403-error-resend-dev-domain).

`https://reset.example.invalid/auth/reset-password` is an intentionally
non-deployed placeholder, not a functioning Android URL. The mailer validates URL
syntax, not hosting or App Link ownership. Mail receipt and manual API reset can
be tested with this placeholder; clicking it will not complete a reset. End-to-end
Android testing requires an owner-supplied HTTPS development URL, a matching
Android intent filter and the appropriate App Link association. Keep the token
in the fragment; do not change to a custom scheme or claim a verified link exists.
No Android package name, deployed page or domain is assumed by this backend.

When the owner is ready to send a real test email:

1. Revoke the compromised key, create a replacement and inject it privately.
   Use an isolated local PostgreSQL database and local API only. Keep existing
   JWT settings; never point this test at Neon production.
2. Set the non-secret SMTP values above, decide whether to test only receipt/manual
   reset or supply a working Android URL, then restart the local API. Do not dump
   environment variables or enable Nodemailer debug logging.
3. Register or log in to a disposable Brandora User with the Resend account email.
   Keep a test access/refresh session privately if testing session invalidation.
4. In a private local API client, send `POST /auth/forgot-password` to
   `http://127.0.0.1:3000` with JSON `{ "email": "<RESEND_ACCOUNT_EMAIL>" }`.
   Expect generic HTTP 200, not confirmation of delivery. Check the owner's inbox,
   spam folder and Resend email status privately; do not export bodies or links.
5. Extract the `token` from the email link's `#token=...` fragment privately, and
   send `POST /auth/reset-password` with `token` and a new disposable password.
   Expect 204. Do not put either value in URL queries, command history or shared
   API-client collections. With the placeholder URL, this is a manual API test.
6. Reusing the token must return 400 `AUTH_RESET_INVALID`. The old password must
   fail, the new password must log in, and old access/refresh sessions must fail.
   Requesting a newer reset supersedes the older one; tokens expire in 15 minutes.
7. Missing configuration returns 503 `AUTH_EMAIL_UNAVAILABLE` for both known and
   unknown accounts. With configuration present, SMTP failures still return the
   generic 200 to avoid account enumeration, emit a sanitized server error and
   mark the reset FAILED/consumed. SMTP acceptance is not inbox delivery. Do not
   retry repeatedly: a new request invalidates the previous token and rate limits
   apply. Inspect provider status and sanitized logs, never raw SMTP exceptions.
8. Set `AUTH_EMAIL_MODE=disabled` and remove the injected SMTP secret after testing.

Maintained mocked transport and failure-response checks run with
`npm test -- --runTestsByPath verification/regressions/resend-smtp.spec.ts`.
They never connect to Resend or send email. The existing isolated PostgreSQL
hardening verifier continues to test single-use reset and session revocation.

## Profile and switching businesses

`GET /auth/me` requires a token and returns all active memberships. Identity comes
only from the token; supplying a userId cannot select another account:

```json
{
  "id": "f6bc7287-3285-4e19-a819-459c41f0a138",
  "email": "owner@example.com",
  "businesses": [
    {
      "id": "c06a904b-14a7-4de7-98c9-9cac5bb4559b",
      "name": "Business A",
      "role": "OWNER"
    },
    {
      "id": "b2621a53-0797-4b1d-84f9-5f9a41697f5c",
      "name": "Business B",
      "role": "OWNER"
    }
  ]
}
```

Android selects an ID from this list, then changes businessId in requests. The
same JWT works for every active owned Business, without another login.

Authenticated `POST /businesses` retains its body and profile response, e.g.
`{ "name": "Business A", "category": "Bakery" }`. Business, default settings
and active OWNER membership are created atomically through a Prisma transaction
and nested write. Creator identity comes from the token. A User can create many
Businesses; membership is unique per (userId,businessId), never per userId alone.
Clients cannot assign roles or claim existing Businesses.

`GET /businesses?limit=20&offset=0` returns `{ pagination, items }` with existing
profile objects, filtered to active OWNER memberships. Limit is 1–100; offset is a
nonnegative safe integer. Order is createdAt DESC, id DESC, with a repeatable-read
snapshot. `/auth/me` reports all active memberships; OWNER is currently the only
enum role. Legacy unowned Businesses remain inaccessible: no ownership backfill,
claim endpoint, automatic assignment, deletion or cleanup exists.

## Authorization and errors

Every business request checks current database membership, isActive=true and
role=OWNER. No membership decisions are cached or trusted from JWT claims.

| Routes                                                               | Business scope                                       |
| -------------------------------------------------------------------- | ---------------------------------------------------- |
| Business profile/settings/hours; Category/Product/Variant; Inventory | Path businessId                                      |
| Excel analyze and Business import history                            | Path businessId, before uploads                      |
| Catalog POST/PATCH                                                   | Body businessId, matching existing DTOs              |
| Catalog GET/list/DELETE                                              | Query businessId, matching existing DTOs             |
| ImportJob, mapping, validation, preview, execution                   | Minimal ImportJob businessId lookup, then membership |
| Business create/list and auth/me                                     | Validated current user                               |

Existing nested-resource scoping remains intact. Import ownership is immutable
through current APIs. Revocation denies the next request and removes membership
from business lists. It does not cancel a request already authorized and running;
the HTTP-boundary check is not a transaction spanning the entire operation.

Errors retain `{ statusCode, code, message, error }`:

| Status/code                     | Android action                                                         |
| ------------------------------- | ---------------------------------------------------------------------- |
| 400 VALIDATION_ERROR            | Correct request input                                                  |
| 401 UNAUTHORIZED                | Missing, malformed, expired or invalid token: log in again             |
| 401 INVALID_CREDENTIALS         | Show generic email/password failure                                    |
| 404 NOT_FOUND                   | Unknown/unowned Business or ImportJob: refresh accessible Businesses   |
| Resource-specific 404           | Hidden/mismatched nested resource within authorized Business           |
| 403 FORBIDDEN                   | Authenticated request has no allowed route policy                      |
| 409 EMAIL_UNAVAILABLE           | Registration email unavailable                                         |
| 429 AUTH_RATE_LIMITED           | Back off before retrying                                               |
| 401 AUTH_REFRESH_INVALID        | Clear session and log in again                                         |
| 400 AUTH_RESET_INVALID          | Request a new reset link                                               |
| 503 AUTH_EMAIL_UNAVAILABLE      | Recovery configuration is unavailable; retry after operator resolution |
| 503 AUTH_RATE_LIMIT_UNAVAILABLE | Retry after the Retry-After interval                                   |

## Rate limiting and security limits

The injectable AuthRateStore uses **shared PostgreSQL**, with atomic counters and
allocation under a transaction advisory lock across instances. No Redis service
is declared in this workspace and no production service was queried or created.
PostgreSQL is already part of the deployment architecture; Redis can later
implement the same abstraction if its credentials/availability are approved.

| Operation             | IP quota      | Account/token quota                |
| --------------------- | ------------- | ---------------------------------- |
| Registration          | 10/minute     | 3/hour per normalized email        |
| Login                 | 30/minute     | 10/15 minutes per normalized email |
| Refresh, token logout | 60/minute     | 30/minute per opaque token         |
| Forgot password       | 10/15 minutes | 3/15 minutes per normalized email  |
| Reset password        | 10/15 minutes | 5/15 minutes per token             |

Invalid requests consume quota. Keys are purpose-separated HMACs, not raw email
or IP values. AUTH_RATE_LIMIT_SECRET may specify a separate random 32+ byte key;
otherwise a purpose-derived JWT_SECRET key is used. All replicas must use the
same key. Changing it resets effective quotas until old buckets expire.

AuthRateBucket holds at most 10,000 slots. Expired keys are reused when at
capacity; no business data is deleted. If no slot is available, sensitive requests
fail closed with 429. Counters saturate after the denial threshold. Windows use
the database UTC clock, independent of node or PostgreSQL display timezone.
Database timeout/failure returns 503 AUTH_RATE_LIMIT_UNAVAILABLE and
Retry-After: 5 only from sensitive auth operations. Business routes do not use
this limiter. A complete database outage naturally also affects their DB access.
The coarse auth-only allocation lock is suitable for this MVP; monitor contention
before high-volume deployment.

429 responses include Retry-After in seconds until the exceeded window resets
(60 seconds for full allocation capacity). At most two password operations run
concurrently per process; saturation returns 429 with Retry-After: 1.

AUTH_TRUSTED_PROXY_CIDRS is empty by default: X-Forwarded-For is ignored and the
socket peer is used. Configure only verified ingress peer CIDRs; forwarded chains
are read from the trusted right edge and stop at the first untrusted hop. Addresses
are canonicalized, including IPv4-mapped IPv6. Do not trust arbitrary forwarding
headers, all private networks or a guessed hop count. Railway's actual peer
addresses and forwarding/sanitization behavior must be verified by the deployer;
this task did not access production. Until configured, users behind a shared
Railway proxy may share the IP quota. HTTPS terminates at the ingress; CORS is not
authorization.

Email verification, MFA, invitations and staff management remain out of scope.
Registration still reveals email availability through 409; login and recovery
responses do not reveal existence. See [dependency remediation](security-remediation.md)
for the audited versions and compatibility overrides.

## Additive database rollout

Migration 20261029000000_auth_security_hardening adds User.authVersion,
AuthSession, PasswordResetToken and AuthRateBucket. Existing credential/profile,
membership, Product and inventory data is preserved. Previous migrations are
unchanged. Old access tokens without sid/ver become invalid; existing Users must
log in once after rollout to receive a server-backed session. No legacy ownership
backfill, token backfill, database reset or cleanup is performed.

## Verification

Run `npm test` for maintained source regressions and authentication policy tests.
With isolated PostgreSQL on 127.0.0.1:55439, run `npm run test:auth:postgres` and
`npm run test:products:postgres` and `npm run test:auth-hardening:postgres`.
These create and retain fresh local databases.
Neither accesses Neon, executes maintenance cleanup or deletes existing records.
