# Authentication and security

The [Auth API](auth-api.md) remains the detailed request/response reference until
Swagger coverage is accepted. This guide describes the security model; it does
not introduce a separate login, OTP-verification or browser-reset flow.

## Registration and login

Registration creates a User and refresh session transactionally. Email is
trimmed/lowercased, ASCII email syntax is required, and duplicate registration
returns EMAIL_UNAVAILABLE. This intentionally reveals registration availability.
Login uses the same INVALID_CREDENTIALS response for unknown users and incorrect
passwords, including Argon2id verification against a dummy hash for unknown users.

Passwords are not trimmed. Registration/reset require 12–128 UTF-16 code units
with lowercase, uppercase and a digit; login accepts 1–128 units for a generic
credential response. Argon2id uses 64 MiB memory, three iterations and one lane.
Two password workers per process bound expensive hash/verify concurrency; this
is separate from the shared request quotas.

## Access tokens and sessions

Access tokens are HS256 JWTs with issuer/audience validation and a 15-minute
lifetime. JWT_SECRET must contain at least 32 UTF-8 bytes; JWT_ISSUER and
JWT_AUDIENCE are required. No signing defaults are supplied. Every protected
request checks the current User.authVersion and an unrevoked, unexpired session.
The JWT identifies the User/session, not an authoritative selected Business.

Refresh tokens are opaque, fixed-format values. Only SHA-256 fingerprints are
stored. Sessions have a fixed 30-day expiry, at most ten reusable device slots
per User and at most 1,000 rotations per family. Refresh locks the User and
rotates once. Reuse of a known old token revokes that family; revocation commits
before the invalid-refresh response is thrown. Clients should use a single-flight
refresh operation, not race multiple replacements.

Token logout is idempotent and can revoke the family using its current or known
rotated token. Logout-all increments authVersion and revokes active sessions.
Changing signing keys or issuer/audience also invalidates existing access tokens.

## Email OTP recovery

Forgot Password uses Brevo HTTPS when explicitly configured. Invalid/disabled
mail configuration returns the same 503 before account lookup. Configured known
and unknown accounts receive the same generic 200 response, padded to at least
8.5 seconds. This reduces ordinary timing differences; it is not constant-time
processing or a promise of inbox delivery.

The code is an eight-ASCII-digit string, including leading zeroes. An
email/purpose-bound HMAC-SHA256 fingerprint is stored, using AUTH_RATE_LIMIT_SECRET
or the JWT_SECRET fallback. Codes expire after 15 minutes. A resend replaces the
previous code even if delivery fails; an immediate RNG repeat is regenerated.
Only SENT codes can redeem. Delivery has an eight-second header/body deadline;
failure attempts to mark the code FAILED and consumed. PENDING codes remain
unusable if failure recording also fails.

Reset submits email, otp and newPassword together. Under the User lock it checks
the code again, consumes it, changes the password, increments authVersion and
revokes sessions atomically. Success is an empty 204; normal login follows.
Wrong/expired/replaced/consumed codes use AUTH_RESET_INVALID. There is no separate
verify-only endpoint, registration email verification, reset link or automatic
login after reset. Do not log codes, passwords or token bodies.

## Authorization and business isolation

The global AuthGuard requires an explicit route policy. Identity routes require
a valid session; tenant routes additionally require current active OWNER
membership. Import routes resolve the job's Business server-side. Foreign,
inactive or missing membership is hidden as `404 NOT_FOUND`; invalid credentials
use `401 UNAUTHORIZED`. Guard rejection can precede UUID/body validation.

Services still scope resource queries by businessId and parent identity.
ProductAccessService checks existence/ownership of resource relationships, not
the caller's membership. Composite foreign keys add database-level tenant
protection. See [architecture](architecture.md) and [database](database.md).

Public-policy routes are the six public Auth operations, App Links and two
WhatsApp webhooks. The latter verify a secret/raw-body signature. Internal AI
is exempt from owner JWT only and requires its distinct service token plus
signed context. These are different security boundaries, not interchangeable
Bearer tokens.

## Rate limiting and proxy trust

Register, login, refresh, token logout, forgot and reset use the shared
PostgresAuthRateStore. Quotas are fixed windows; the exact IP/account table is
maintained in the [Auth contract](auth-api.md#rate-limiting-and-security-limits).
Forgot allows 3/account and 10/IP per 15 minutes; reset allows 5/account and
10/IP per 15 minutes. Resending, changing IP or restarting does not replenish
the account bucket. HMAC-separated keys avoid persisting raw emails/IPs/tokens.

Exhaustion returns 429 AUTH_RATE_LIMITED with Retry-After. Store outages fail
closed with 503 AUTH_RATE_LIMIT_UNAVAILABLE and Retry-After; password-worker
saturation also uses 429. Respect the returned header instead of a tight retry.

The resolver starts with the socket peer. Empty AUTH_TRUSTED_PROXY_CIDRS trusts
no forwarded headers. Only an explicitly trusted peer permits right-to-left
X-Forwarded-For resolution; malformed selected addresses are rejected. Do not
trust all proxies, arbitrary private ranges or client-supplied headers. Shared
proxy peers may aggregate unrelated users. No current Railway per-client ingress
boundary was verified by this documentation work. The retained
[proxy review](railway-proxy-security.md) requires owner infrastructure review.

## Errors and information ownership

Intentional AppHttpException failures retain their public code/status/message.
Unexpected server failures are sanitized by the global filter. Error-code
localization belongs to Android; stored owner content must not be translated or
rewritten as an error message. Customer-facing AI/WhatsApp text is a separate
content contract. See [error handling](api-errors.md) and
[localization ownership](api-guide.md#localization-ownership).

No notification service, external provider or AI tool receives owner passwords,
refresh tokens or access tokens. Provider keys remain Backend configuration.
Live email delivery, ingress security and release signing require separate
acceptance; mocked tests do not establish them.
