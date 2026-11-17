const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const envPath = path.join(root, '.env');
if (!fs.existsSync(envPath)) throw new Error('Create .env first (step 0.4)');
const aiPort = process.argv[2] || '8000';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const pem = (key, type) => key.export({ type, format: 'pem' }).trim();
const oneLine = (text) => text.replace(/\r?\n/g, '\\n');
const token = () => crypto.randomBytes(32).toString('base64url'); // 43 printable characters
const toAi = token();
const toBackend = token();

const backend = {
  AI_INTEGRATION_ENABLED: 'true',
  AI_BASE_URL: `http://127.0.0.1:${aiPort}`,
  AI_SERVICE_TOKEN: toAi,
  BACKEND_SERVICE_TOKEN: toBackend,
  AI_CONTEXT_PRIVATE_KEY: oneLine(pem(privateKey, 'pkcs8')),
};
let env = fs.readFileSync(envPath, 'utf8');
for (const [name, value] of Object.entries(backend)) {
  const line = `${name}="${value}"`;
  const pattern = new RegExp(`^${name}=.*$`, 'm');
  env = pattern.test(env)
    ? env.replace(pattern, () => line)
    : env.replace(/\n?$/, '\n') + line + '\n';
}
fs.writeFileSync(envPath, env);

const port = /^PORT="?(\d+)"?/m.exec(env)?.[1] || '3000';
const dir = path.join(root, '.tmp', 'ai-dev');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(
  path.join(dir, 'ai.env'),
  [
    'APP_ENV=local',
    'AI_INTEGRATION_ENABLED=true',
    `AI_SERVICE_TOKEN=${toAi}`,
    `BACKEND_SERVICE_TOKEN=${toBackend}`,
    `BACKEND_BASE_URL=http://127.0.0.1:${port}`,
    `BACKEND_CONTEXT_PUBLIC_KEY="${oneLine(pem(publicKey, 'spki'))}"`,
    'AI_PROVIDER=rules',
    'LEGACY_API_ENABLED=false',
    'ENABLE_DEV_ENDPOINTS=false',
    '',
  ].join('\n'),
);
console.log(
  'Updated .env (AI_* and BACKEND_SERVICE_TOKEN). Restart the server.',
);
console.log(
  'AI service settings: .tmp/ai-dev/ai.env (public key only, not in Git)',
);
