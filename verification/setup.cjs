// Persistence is mocked in the maintained HTTP/unit suites. Never use .env URLs.
process.env.DATABASE_URL =
  'postgresql://postgres@127.0.0.1:55439/unused_mock_tests';
process.env.PORT = '3000';
