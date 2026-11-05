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

## Forgot and reset password (OTP only)

This release replaces email reset links with an eight-digit email OTP. Android
must update its reset request at the same rollout; legacy token bodies are rejected.
There is no separate verify-only endpoint or password-reset session: submit the
code together with the new password. Do not treat a frontend code-entry screen
as proof that the server has verified the code.

1. POST `/auth/forgot-password` with `{ "email": "owner@example.com" }`.
2. Read the eight-digit code from the email and keep it as a string, including
   leading zeroes. Do not put codes in URLs, logs, analytics or persistent storage.
3. POST `/auth/reset-password` with:

```json
{
  "email": "owner@example.com",
  "otp": "01234567",
  "newPassword": "NewSecurePassword123!"
}
```

Success is 204 with an empty body. The server atomically consumes the code,
changes the password, increments authVersion and invalidates all existing
sessions. Require normal login afterward. The registration password policy is
unchanged. Email is trimmed/lowercased; the OTP is exactly eight ASCII digits,
never converted to a number or trimmed. Unexpected properties, including the
legacy `token`, and malformed fields return 400 VALIDATION_ERROR.

Wrong, expired, consumed, superseded or unconfirmed-delivery codes return the
existing generic 400 AUTH_RESET_INVALID message, “Invalid or expired password
reset token”. The wording intentionally preserves the error contract.
Only SENT codes redeem, with a second check under the user lock. No account
lookup result, code or delivery status appears in the response.

Configured forgot requests return the same HTTP 200 for known/unknown accounts:

```json
{ "message": "If the account exists, a password reset has been requested. Check your email; delivery may be delayed or unavailable." }
```

Delivery is synchronous with an 8-second HTTPS header/body timeout and an
8.5-second minimum forgot response duration. This remains practical timing
padding, not a constant-time guarantee; unusually slow databases can exceed it.
Invalid mail configuration returns the same 503 AUTH_EMAIL_UNAVAILABLE before
account lookup. Provider failures remain generic 200 with sanitized logging.
They attempt to mark the matching code FAILED and consumed; PENDING codes remain
unusable if that database write also fails. API acceptance is not inbox delivery.

### Code security, limits and resend

Codes use Node's cryptographic randomInt over 100,000,000 values, expire after
15 minutes and are single-use. Only an HMAC-SHA256 fingerprint, bound to the
email and a password-reset purpose context, is stored in the existing
PasswordResetToken.tokenHash column. Plain SHA256 is insufficient for a short
numeric code because a database leak would enable offline enumeration.

The HMAC uses the existing AUTH_RATE_LIMIT_SECRET, falling back to JWT_SECRET;
the selected key must be at least 32 bytes and identical on all replicas.
No additional secret or migration is introduced. Rotating the selected key
invalidates outstanding codes. Refresh/access-token hashing and JWT behavior
are unchanged.

Forgot/resend limits remain 3/account and 10/IP per 15 minutes. Reset attempts,
including failed guesses, are limited by the shared database rate store to
5/account and 10/IP per 15 minutes, regardless of the submitted code. These are
fixed-window request limits, not five guesses for every new code. Changing IP,
restarting a process or requesting another code does not clear the account
bucket. Store failures fail closed with AUTH_RATE_LIMIT_UNAVAILABLE; exhaustion
returns 429 AUTH_RATE_LIMITED with Retry-After. Do not lock the user's login.

Resend uses the same forgot endpoint. Each new request replaces the previous
code under the user lock, including when the new delivery fails. An immediate
RNG repeat of the previous code is regenerated. There is no automatic provider
retry, queue or background worker. Out-of-order emails may contain obsolete
codes: use the latest request, and respect Retry-After before trying again.

### Brevo configuration and sender verification

```dotenv
AUTH_EMAIL_MODE=brevo
BREVO_API_KEY=<private-api-key>
BREVO_SENDER_EMAIL=<verified-bare-email-address>
```

Email defaults to disabled. Use an actual Brevo API key, not SMTP credentials.
Verify the exact sender in the intended Brevo account and authenticate the
domain you control. See [Brevo sender/domain requirements](https://developers.brevo.com/docs/getting-started-with-senders-and-domains).
Neither syntax validation nor mocked tests establish provider verification.
No provider/DNS/Railway settings are changed automatically. Never publish keys.

POST https://api.brevo.com/v3/smtp/email uses the api-key header, sender/to
objects and textContent; a nonempty messageId confirms API acceptance only.
Redirects, malformed responses, provider errors and timeouts produce sanitized
failures. Tests never send email. Legacy resend/smtp modes are rejected;
RESEND_API_KEY, SMTP_FROM and the old SMTP transport variables are ignored.
AUTH_RESET_URL is no longer used by password recovery. The public Android
association JSON remains available, but no code or link is redeemed via GET.
Previously emailed opaque tokens cannot be redeemed by this OTP-only API.

### Verification and rollout gates

Run the mocked Brevo, password-reset, password-reset-otp, auth-hardening and
app-links suites. They cover input validation, expiry, single use, locked
rechecks, delivery failures, shared attempt limits and session invalidation.
See [verification](../verification/README.md). The existing local PostgreSQL
hardening script additionally exercises reset races; do not run it against
production or claim its previous link-mode results validate the new contract.

Real email still requires separate explicit approval. Use a disposable local
account/database and inbox you control; privately inject verified Brevo settings.
Check acceptance, provider delivered/bounced status and actual inbox/spam receipt
separately. Enter the code in Android, reset within 15 minutes, check old-password
failure, new-password login, code reuse rejection and revoked access/refresh
sessions. Use separate codes for expiry and resend checks; do not log them.
Disable test sending afterward. No real email was sent by implementation/tests.

Coordinate the Android email/otp/newPassword request with this API change before
deployment. Auth needs no schema change; the separate Product/ProductImage work
still needs its [coordinated database rollout](product-domain-database-rollout.md).
Security guidance: [OWASP Forgot Password](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html).

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
| 400 AUTH_RESET_INVALID          | Request a new reset code within rate limits                             |
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

AUTH_TRUSTED_PROXY_CIDRS is empty by default: forwarding headers are ignored and
the socket peer is used. With verified proxy CIDRs, X-Forwarded-For is read from
the right and stops at the first untrusted hop. X-Real-IP and Express req.ip are
not used. IPv6 and mapped IPv4 addresses are canonicalized. Express trust proxy
is not enabled by this application.

This is a spoof-resistant fallback, **not a complete Railway per-client IP
configuration**. Shared proxy peers share IP quotas and can block unrelated users.
Railway publishes neither a stable proxy CIDR allowlist nor a fixed hop count;
do not guess either or trust X-Real-IP on private/direct requests. There is no
environment-only setting that solves ingress authentication in the current code.
See [Railway proxy security review](railway-proxy-security.md) for the deployment
blocker, required boundary and locally proven tests. No production settings were
inspected or changed. CORS is not authorization.

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
