# Android association status and OTP recovery

Password recovery now uses **email OTP only**. No reset link is sent;
AUTH_RESET_URL is unused and legacy token request bodies are rejected.
Android submits email, otp (eight-digit string) and newPassword to
POST /auth/reset-password. See [Android integration](android-integration-guide.md#11-password-reset-with-email-otp)
and [Authentication](auth-api.md#forgot-and-reset-password-otp-only).

The existing public GET /.well-known/assetlinks.json remains unchanged: HTTP 200,
application/json, no authentication or redirect. It associates
com.yasminhosam.brandora with the existing development certificate:

```text
51:F3:C3:2A:04:7C:8B:34:0B:24:28:DE:8F:80:6F:1F:31:96:EC:AB:93:04:FF:B6:C2:DE:E6:4B:73:56:08:2E
```

This association is not OTP verification or proof of database/email readiness.
The matching debug build is covered; release/Play signing needs a separately
reviewed certificate. No Android app, domain or association response was modified.
There is no browser reset UI or GET reset-password handler. Old reset links no
longer provide a supported recovery path; request a fresh OTP in the app instead.

Maintained Backend checks include app-links.spec.ts (association response and
OTP POST contract), brevo-api.spec.ts, password-reset-otp.spec.ts and
auth-password-reset.spec.ts. They do not prove real device or inbox behavior.
See [Android association documentation](https://developer.android.com/training/app-links/configure-assetlinks).
