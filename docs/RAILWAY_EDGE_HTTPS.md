# Explicit Railway public-edge HTTPS mode

This is an optional deployment trust policy, disabled by default. It does not
replace service credentials, signed Backend context, tenant validation or body
hash binding. It does not discover a safe proxy IP range.

## Required operator boundary

Railway terminates public TLS before forwarding to the application. Its public
edge supplies X-Forwarded-Proto and X-Forwarded-Host. See the
[public networking specifications](https://docs.railway.com/networking/public-networking/specs-and-limits).

Use this mode ONLY when:

- The generated Railway HTTPS domain is the only untrusted ingress route.
- There is no TCP proxy or other direct listener exposed to untrusted callers.
- All other services and users able to connect through that project's private
  network are trusted. Reassess before adding an untrusted workload or connector.
- The operator accepts the platform's forwarding-header guarantees at that boundary.

Forwarding headers and Railway deployment environment variables are not
cryptographic proof of origin. A caller that can bypass the edge and reach the
listener directly can forge the same headers. The domain checks reduce accidental
cross-service routing; they do not authenticate that direct caller. Do NOT use
this mode in an untrusted shared private network. Retain verified CIDR mode or
establish an authenticated proxy boundary in that deployment instead.

## Configuration

```dotenv
APP_ENV=production
AI_PROVIDER=rules
AI_INTEGRATION_ENABLED=true
RAILWAY_EDGE_HTTPS_ENABLED=true
```

Leave TRUSTED_PROXY_CIDRS unset/empty in this mode. Do not use wildcard CIDRs.
Railway must inject the service's generated RAILWAY_PUBLIC_DOMAIN and UUID
RAILWAY_PROJECT_ID, RAILWAY_ENVIRONMENT_ID and RAILWAY_SERVICE_ID. Local mode,
missing identities, invalid domains and mixed proxy modes are rejected.

The domain currently must have the shape service-name.up.railway.app. Custom
domains are deliberately outside this change. Do not set RAILWAY_PUBLIC_DOMAIN
to the Backend's domain or to a URL containing a scheme, path or port.

For the edge upgrade, exactly one Host and one X-Forwarded-Host must match that
domain, and exactly one X-Forwarded-Proto must equal https. Duplicate headers,
comma-separated protocols, missing headers and another hostname do not upgrade
the ASGI scheme. The canonical endpoint still requires HTTPS and independently
validates its service token, RS256 context, identities, expiry and exact body hash.
Uvicorn's unconditional proxy-header handling remains disabled.

The original explicit trusted-socket-CIDR mode is unchanged when this flag is off.

## Deployment and acceptance

- Run the maintained offline tests and the new tests/test_railway_edge_https.py.
- Keep python -m app.server, /health/live and the existing restart policy.
- Pin/review this source change before deployment; a GitHub deployment of the
  unmodified base commit does not contain it.
- Verify the actual deployment's header behavior and domain before enabling
  real customer requests. Synthetic ASGI tests do not certify a live edge.
- /ready separately probes Backend /internal/ai/health. That Backend route is
  not added by this change, so /ready can remain 503 despite process liveness.
- AI_PROVIDER=rules selects the release container's safe legacy provider. It
  does not disable canonical Groq composition when a Groq key is provided.
  Without a model key, the prepared configuration uses deterministic fallback.
- No subscription upgrade, live model call, database access or WhatsApp send is
  needed to run the offline regression tests.

No Backend source or API contract is modified by this patch.
