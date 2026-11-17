const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

function verifyContext(token, publicKey, body) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const ok = crypto.verify(
    'RSA-SHA256',
    Buffer.from(parts[0] + '.' + parts[1]),
    publicKey,
    Buffer.from(parts[2], 'base64url'),
  );
  if (!ok) return null;
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  const hash = crypto.createHash('sha256').update(body).digest('hex');
  if (claims.requestHash !== hash || claims.exp <= Date.now() / 1000)
    return null;
  return claims;
}

/** Starts the fake. Returns the http.Server (tests close it). backendUrl may be a function. */
function startFakeAi({ port, backendUrl, aiToken, backendToken, publicKey }) {
  const backend = () =>
    typeof backendUrl === 'function' ? backendUrl() : backendUrl;
  const tool = async (context, name, args) => {
    const res = await fetch(`${backend()}/internal/ai/data`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${backendToken}`,
        'X-AI-Context': context,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tool: name, arguments: args }),
    });
    if (!res.ok) throw new Error(`${name} answered ${res.status}`);
    return (await res.json()).data;
  };

  const answer = async (request, context) => {
    const text = request.message;
    const history = await tool(context, 'get_conversation_history', {
      conversationId: request.conversationId,
      limit: 20,
      offset: 0,
    });
    const products = (await tool(context, 'get_products', { limit: 20 })).items;
    const sellable = products.filter((p) => p.isSellable);
    const named =
      sellable.find((p) => text.includes(p.name)) ??
      sellable.find((p) =>
        p.name.split(' ').some((w) => w.length > 2 && text.includes(w)),
      ) ??
      sellable[0];
    const price = named?.variants.find(
      (v) => v.isActive && v.effectivePrice,
    )?.effectivePrice;

    if (/أكلم|اكلم|حد يكلمني|شكوى|مش راضي|اتأخر/.test(text))
      return {
        intent: 'OTHER',
        reply: 'آسفين جدًا على كده. هبلّغ صاحب المحل يتابع معاك بنفسه.',
        requiresReview: true,
      };
    if (/بكام|سعر|كام/.test(text) && named && price)
      return {
        intent: 'INQUIRY',
        reply: `${named.name} بـ ${price} جنيه.`,
        requiresReview: false,
      };
    if (/عايز|عاوز|عايزة|اطلب|هاخد/.test(text))
      return {
        intent: 'PURCHASE_INTENT',
        reply: named
          ? `تمام! ${named.name}${price ? ` بـ ${price} جنيه` : ''}. صاحب المحل هيأكد معاك الطلب.`
          : 'تمام! قولي اسم المنتج اللي عايزه.',
        requiresReview: false,
      };
    const again = history.items.some((m) => m.senderType === 'CUSTOMER');
    return {
      intent: 'OTHER',
      reply: again
        ? 'أهلًا بيك تاني! تحب تسأل عن إيه؟'
        : 'أهلًا بيك! تحب تسأل عن إيه؟',
      requiresReview: false,
    };
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      const send = (status, json) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(json));
      };
      if (req.method !== 'POST' || req.url !== '/v2/ai/respond')
        return send(404, { detail: 'Not found' });
      if (req.headers['x-internal-token'] !== aiToken)
        return send(401, { detail: 'Invalid service token' });
      const context = req.headers['x-ai-context'];
      if (!verifyContext(context, publicKey, body))
        return send(401, { detail: 'Invalid context' });
      try {
        const result = await answer(JSON.parse(body.toString('utf8')), context);
        send(200, { ...result, orderCandidate: null });
      } catch (error) {
        console.error('[fake AI]', error.message);
        send(503, { detail: 'Backend tools failed' });
      }
    });
  });
  server.listen(port, '127.0.0.1');
  return server;
}

module.exports = { startFakeAi };

if (require.main === module) {
  const root = path.resolve(__dirname, '..', '..');
  const env = fs.readFileSync(path.join(root, '.env'), 'utf8');
  const read = (name) =>
    new RegExp(`^${name}="?([^"\\r\\n]*)"?`, 'm').exec(env)?.[1];
  const key = read('AI_CONTEXT_PRIVATE_KEY');
  if (!key)
    throw new Error(
      'Run node verification/tools/make-ai-dev-secrets.cjs first',
    );
  const aiUrl = new URL(read('AI_BASE_URL') || 'http://127.0.0.1:8000');
  startFakeAi({
    port: Number(aiUrl.port || 80),
    backendUrl: `http://127.0.0.1:${read('PORT') || 3000}`,
    aiToken: read('AI_SERVICE_TOKEN'),
    backendToken: read('BACKEND_SERVICE_TOKEN'),
    publicKey: crypto.createPublicKey(key.replace(/\\n/g, '\n')),
  });
  console.log(`Fake AI listening on ${aiUrl.origin} (Ctrl+C to stop)`);
}
