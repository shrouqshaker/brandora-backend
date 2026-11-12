// Sends a webhook to your LOCAL server, signed exactly like Meta signs it.
// Development only. Reads WHATSAPP_APP_SECRET and PORT from .env.
//
//   node verification/tools/send-whatsapp-webhook.cjs "عايز 2 تيشيرت"              a new message
//   node verification/tools/send-whatsapp-webhook.cjs "مرحبا" wamid.test-1          same id twice = duplicate
//   node verification/tools/send-whatsapp-webhook.cjs --status <wamid> delivered    a delivery report
//
// Optional: PHONE_NUMBER_ID=... (your business number at Meta), FROM=2010... (the customer).
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const env = fs.readFileSync(path.join(root, '.env'), 'utf8');
const read = (name) =>
  new RegExp(`^${name}="?([^"\\r\\n]*)"?`, 'm').exec(env)?.[1];
const secret = read('WHATSAPP_APP_SECRET');
if (!secret) throw new Error('Put WHATSAPP_APP_SECRET in .env first');
const port = read('PORT') || '3000';

const payload = JSON.parse(
  fs.readFileSync(
    path.join(root, 'verification/fixtures/whatsapp-text.json'),
    'utf8',
  ),
);
const value = payload.entry[0].changes[0].value;
if (process.env.PHONE_NUMBER_ID)
  value.metadata.phone_number_id = process.env.PHONE_NUMBER_ID;

if (process.argv[2] === '--status') {
  // A report about a message WE sent: no contacts, no messages.
  delete value.contacts;
  delete value.messages;
  value.statuses = [
    {
      id: process.argv[3],
      status: process.argv[4] || 'delivered',
      timestamp: String(Math.floor(Date.now() / 1000)),
      recipient_id: process.env.FROM || '201000000001',
    },
  ];
} else {
  const message = value.messages[0];
  message.text.body = process.argv[2] || 'السلام عليكم';
  message.id = process.argv[3] || `wamid.test-${Date.now()}`;
  message.timestamp = String(Math.floor(Date.now() / 1000));
  if (process.env.FROM) {
    message.from = process.env.FROM;
    value.contacts[0].wa_id = process.env.FROM;
  }
}

const body = Buffer.from(JSON.stringify(payload));
const signature =
  'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');

fetch(`http://localhost:${port}/webhooks/whatsapp`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Hub-Signature-256': signature,
  },
  body,
})
  .then(async (res) => console.log(res.status, await res.text()))
  .catch((error) => {
    console.error('Is the server running?', error.message);
    process.exitCode = 1;
  });
