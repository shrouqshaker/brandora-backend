# Railway ingress and Auth rate-limit security review

## Verdict and limits of this review

The current socket-first resolver resists caller-controlled forwarding headers
when proxy trust is empty. It cannot establish that a request traversed Railway's
public edge. It can therefore aggregate unrelated clients behind a shared proxy
peer. **Railway per-client rate limiting is not deployment-ready yet.**
No production service, environment variables, headers or network paths were
inspected. Local tests prove application behavior only. The owner's successful
SMTP test does not establish an ingress trust boundary.

## Current implementation

- `auth-rate.guard.ts` starts with `request.socket.remoteAddress`. It does not use
  Express `req.ip`/`req.ips`, X-Real-IP, Forwarded, CF-Connecting-IP, Host or Railway
  metadata as proof of client identity.
- AUTH_TRUSTED_PROXY_CIDRS is split on commas, trimmed and empty entries removed.
  `proxy-addr.compile` builds the allowlist and rejects invalid entries. That
  library also supports named ranges; broad aliases such as `uniquelocal` are not
  appropriate evidence of Railway provenance. An empty setting trusts no proxy.
- Only an explicitly trusted socket peer allows X-Forwarded-For selection.
  `proxy-addr` walks right to left, stopping at the nearest untrusted address.
  Selected malformed addresses return 400. Trusted XFF is bounded at 1,024
  characters; untrusted headers are ignored. A CIDR is meaningful only if the
  operator controls that proxy and its forwarding-header replacement policy.
- `ipaddr.process(...).toString()` canonicalizes addresses, including mapped IPv4
  and equivalent IPv6 forms. Different full IPv6 addresses have different keys;
  there is no /64 grouping. NAT users share an address, and VPN/network changes
  can change a real address. IP limits are not persistent user identity.
- `main.ts` does not enable Express trust proxy. No Railway-specific resolver or
  authenticated-ingress middleware exists. Setting trust proxy globally would
  not fix this independent guard.

## Railway boundary

Railway's [public HTTP specifications](https://docs.railway.com/networking/public-networking/specs-and-limits)
identify X-Real-IP as the client address. A
[Railway employee clarification](https://station.railway.com/questions/need-authoritative-client-ip-proxy-tru-090eac86)
confirms edge header replacement, private-network bypass, unpublished proxy CIDRs
and variable hop count. Those statements are about platform behavior, not a
credential available to this listener. Cloudflare-to-Railway IPv6 attribution was
not confirmed in that clarification; do not infer end-user identity for that path.

A direct/private caller reaching the same listener can supply its own headers.
Presence of X-Real-IP, X-Railway-Edge, X-Railway-Request-Id, an HTTPS-looking
X-Forwarded-Proto or the public Host name cannot authenticate the path. Do not
trust all proxies, observed 100.x addresses, private-network ranges, or a fixed
hop count. A proxy service or sidecar accepting the same untrusted paths does not
by itself solve this problem.

## Required deployment strategy

Keep the present fallback until a real ingress boundary is available; do not
silently switch to X-Real-IP or disable IP quotas to conceal aggregation. An
attacker using one shared peer can exhaust its login/registration quota and deny
other users service. Per-account quotas remain separate but do not prevent this
shared-peer denial of service.

The smallest defensible remediation requires an ingress decision first:

1. Use an operator-controlled authenticated gateway that determines the client
   address from its own validated connection/ingress metadata, replaces caller
   assertions and supplies a verifiable client-IP assertion. Authenticate it with
   mTLS or a properly bound signed assertion, not a client-set boolean/header.
   A signed assertion should cover the address and request, have a short validity
   window and appropriate replay protection. Do not log the assertion or secret.
2. Reject Auth requests without valid gateway proof on every reachable path,
   including generated Railway domains, private networking and any TCP exposure.
   Only after proof validation may an application resolver consume the asserted
   address. A leaked static shared header would also need rotation; it is not a
   Railway-supplied credential.
3. Alternatively, demonstrate and enforce network isolation that makes the
   application listener reachable only through a trusted sanitizing ingress.
   Treat that as infrastructure work requiring evidence, not an env flag. Only
   then implement the corresponding resolver. Merely observing a peer IP is
   insufficient.

Neither deployment boundary was configured or proven here. The corresponding
small application gate/resolver should be added once its authenticated contract
is chosen. Adding an unauthenticated Railway header mode now would weaken the
current guard, so no runtime resolver change is made in this review.

## Current environment settings

```dotenv
AUTH_TRUSTED_PROXY_CIDRS=
AUTH_RATE_LIMIT_SECRET=
```

Empty CIDRs are the safe direct-request fallback, not a declaration of Railway
readiness. Empty AUTH_RATE_LIMIT_SECRET derives a purpose-specific key from
JWT_SECRET; alternatively inject a separate random secret of at least 32 bytes.
All replicas must use the same key. JWT_SECRET, JWT_ISSUER and JWT_AUDIENCE remain
required; never publish their secret values. No TRUST_PROXY or Railway-header
mode variable is implemented. There is no currently valid CIDR/hop-count setting
to recommend for Railway's public edge.

## Shared store and failure behavior

All six sensitive Auth operations use PostgresAuthRateStore: register, login,
refresh, token logout, forgot-password and reset-password. See the
[Auth quota table](auth-api.md#rate-limiting-and-security-limits).
Normalized email and full opaque-token keys are distinct from IP keys and are
purpose-separated HMAC-SHA256 values. The store does not persist raw IPs, emails
or tokens. HMAC is pseudonymization, not a reason to make database access public.

Transactions and a shared advisory lock serialize multi-key allocation/counters
across replicas. Expiry uses the database UTC clock. Windows are fixed, counters
saturate, and storage is capped at 10,000 reusable buckets. Exceeding quotas gives
429 AUTH_RATE_LIMITED and Retry-After; exhausted allocation gives Retry-After 60.
Limiter exceptions give 503 AUTH_RATE_LIMIT_UNAVAILABLE and Retry-After 5. There
is no in-memory fallback. Business routes do not invoke this limiter, but a full
database outage also affects their normal persistence/authorization queries.
Monitor advisory-lock contention and pool timeouts before high-volume rollout.
High-cardinality traffic can fill the bucket cap and deny new keys until slots
expire; the bounded fail-closed store is not a substitute for ingress abuse controls.

## Maintained checks and release evidence

Run `npm test` (including auth-proxy.spec.ts), `npm run test:auth:postgres` and
`npm run test:auth-hardening:postgres` with the dedicated local verification
PostgreSQL instance. Verifiers create random fresh databases and retain them.
The proxy suite uses explicit synthetic CIDRs, never guessed Railway ranges.
The hardening verifier tests real concurrent local HTTP calls across two apps,
forged/repeated headers, 429/Retry-After, shared database concurrency, expiry,
reconnection persistence and controlled backend failure. Synthetic trusted peers
prove the branch logic only; the direct HTTP test uses empty proxy trust.

Before production, separately prove the chosen ingress authentication/isolation,
public and private bypass rejection, equivalent-address handling, real-user
separation and NAT behavior on every deployed route to the listener. Do not add
a public endpoint exposing IPs or request headers. Do not claim the current local
tests prove Railway sanitization or eliminate shared-peer denial of service.
