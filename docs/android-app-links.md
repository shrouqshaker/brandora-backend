# Android password-reset App Links

The backend serves public `GET /.well-known/assetlinks.json` with HTTP 200,
`application/json`, no authentication, and no redirect. It associates
`com.yasminhosam.brandora` with the supplied development signing certificate:

```text
51:F3:C3:2A:04:7C:8B:34:0B:24:28:DE:8F:80:6F:1F:31:96:EC:AB:93:04:FF:B6:C2:DE:E6:4B:73:56:08:2E
```

After an approved deployment, configure the existing runtime setting manually:

```dotenv
AUTH_RESET_URL=https://brandora-backend-production-85ec.up.railway.app/auth/reset-password
```

This is a proposed setting, not a claim that the endpoint is deployed. No SMTP
or Railway configuration is changed by this implementation. Email delivery still
requires the existing valid SMTP settings and explicit email-mode configuration.

Add this filter to the Android Activity that handles password resets. Its
package/applicationId must be `com.yasminhosam.brandora` and it must be exported:

```xml
<intent-filter android:autoVerify="true">
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data android:scheme="https"
          android:host="brandora-backend-production-85ec.up.railway.app"
          android:path="/auth/reset-password" />
</intent-filter>
```

The existing mailer appends `#token=<opaque-token>`. Android must read the URI
fragment and submit the token and new password as JSON to the existing
`POST /auth/reset-password`. Never log the incoming URI/token or send it to
analytics, link trackers, or third-party redirects. URL fragments are not sent
in the HTTP request to the backend. No browser reset page or GET reset handler
is added; without a verified installed app, the reset URL has no browser UI.
Single-use tokens and session invalidation remain unchanged.

The supplied fingerprint authorizes only the matching debug-signed build.
Before release, review and add the actual release/Play App Signing certificate
fingerprint; do not assume it matches the debug certificate.

Deployment acceptance: verify the HTTPS association URL returns 200 JSON without
redirects, install the correctly signed Android build with the filter above,
then on Android 12+ run:

```sh
adb shell pm verify-app-links --re-verify com.yasminhosam.brandora
adb shell pm get-app-links com.yasminhosam.brandora
```

Wait for verification and confirm the exact host is verified. Test navigation
with a dummy fragment, never a real reset token in shell history:

```sh
adb shell am start -a android.intent.action.VIEW -c android.intent.category.BROWSABLE -d "https://brandora-backend-production-85ec.up.railway.app/auth/reset-password#token=dummy"
```

Maintained backend checks:

```sh
npm run build
npm test -- --runTestsByPath verification/regressions/app-links.spec.ts verification/regressions/auth.spec.ts verification/regressions/resend-smtp.spec.ts verification/controller-route-inventory.spec.cjs
```

See [Android association documentation](https://developer.android.com/training/app-links/configure-assetlinks).
