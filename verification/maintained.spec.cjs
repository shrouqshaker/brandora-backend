const assert = require('node:assert/strict');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

// The existing business regression uses node:test, not Jest globals. Run its
// native runner in a subprocess rather than executing node:test inside Jest.
test('maintained business HTTP regressions (native Node test runner)', async () => {
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    ['--test', 'verification/businesses.test.cjs'],
    {
      cwd: path.resolve(__dirname, '..'),
      env: {
        ...process.env,
        DATABASE_URL: 'postgresql://postgres@127.0.0.1:55439/unused_mock_tests',
      },
      timeout: 55000,
    },
  );
  process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  assert.match(stdout, /(?:#|ℹ) fail 0/);
}, 60000);
