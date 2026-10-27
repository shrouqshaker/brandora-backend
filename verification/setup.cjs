// Persistence is mocked in the maintained HTTP/unit suites. Never use .env URLs.
process.env.DATABASE_URL =
  'postgresql://postgres@127.0.0.1:55439/unused_mock_tests';
process.env.PORT = '3000';
process.env.JWT_SECRET = require('node:crypto')
  .randomBytes(48)
  .toString('base64');
process.env.JWT_ISSUER = 'brandora-test';
process.env.JWT_AUDIENCE = 'brandora-test-android';
process.env.AUTH_EMAIL_MODE = 'disabled';
process.env.AUTH_TRUSTED_PROXY_CIDRS = '';
