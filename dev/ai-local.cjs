// Separate local NestJS process. NEVER imported by src/main.ts or AppModule.
require('reflect-metadata');
const { randomUUID } = require('node:crypto');
const { isUUID } = require('class-validator');
const { ConfigModule, ConfigService } = require('@nestjs/config');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const express = require('express');

const FIXTURE_EMAIL = 'ai-local@brandora.example.invalid';
const FIXTURE_NAME = 'Brandora AI Local Fixture';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const TOOLS = new Set([
  'get_products',
  'get_product_details',
  'get_product_variants',
  'get_variant_details',
  'get_conversation_history',
]);
const failure = (status, code) =>
  Object.assign(new Error(code), { status, code });

function localDatabase(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw failure(400, 'LOCAL_DATABASE_REQUIRED');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !LOOPBACK.has(url.hostname) ||
    !/^\/brandora_ai_local_[a-f0-9]{32}$/.test(url.pathname) ||
    url.search ||
    url.hash
  )
    throw failure(400, 'LOCAL_DATABASE_REQUIRED');
  return url;
}

function localOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw failure(400, 'LOOPBACK_ORIGIN_REQUIRED');
  }
  if (
    url.protocol !== 'http:' ||
    !LOOPBACK.has(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw failure(400, 'LOOPBACK_ORIGIN_REQUIRED');
  return url.origin;
}

function settings(env = process.env) {
  if (
    env.AI_LOCAL_ENABLED !== 'true' ||
    env.NODE_ENV !== 'development' ||
    env.APP_ENV !== 'local' ||
    env.RAILWAY_ENVIRONMENT_ID ||
    env.RAILWAY_SERVICE_ID ||
    env.RAILWAY_PROJECT_ID
  )
    throw failure(403, 'LOCAL_RUNNER_DISABLED');
  const database = localDatabase(env.AI_LOCAL_DATABASE_URL).toString();
  const origin = localOrigin(env.AI_BASE_URL);
  if (
    ![env.AI_LOCAL_BUSINESS_ID, env.AI_LOCAL_OWNER_ID].every((v) =>
      isUUID(v ?? '', '4'),
    )
  )
    throw failure(400, 'LOCAL_FIXTURE_IDENTITIES_REQUIRED');
  const port = Number(env.AI_LOCAL_PORT ?? 3099);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw failure(400, 'INVALID_LOCAL_PORT');
  return {
    database,
    origin,
    port,
    businessId: env.AI_LOCAL_BUSINESS_ID,
    ownerId: env.AI_LOCAL_OWNER_ID,
  };
}

async function authorize(prisma, config) {
  const member = await prisma.businessMember.findUnique({
    where: {
      userId_businessId: {
        userId: config.ownerId,
        businessId: config.businessId,
      },
    },
    select: {
      role: true,
      isActive: true,
      user: { select: { email: true } },
      business: { select: { name: true } },
    },
  });
  if (
    member?.role !== 'OWNER' ||
    !member.isActive ||
    member.user.email !== FIXTURE_EMAIL ||
    member.business.name !== FIXTURE_NAME
  )
    throw failure(403, 'LOCAL_FIXTURE_AUTHORIZATION_FAILED');
}

// Request-scoped, synthetic context registry; NOT a conversation/history store.
class SyntheticRequests {
  constructor(config, checkOwner, clock = Date.now) {
    this.config = config;
    this.checkOwner = checkOwner;
    this.clock = clock;
    this.active = new Map();
  }
  open(message) {
    if (this.active.size >= 4) throw failure(429, 'LOCAL_RUNNER_BUSY');
    const record = {
      businessId: this.config.businessId,
      customerId: randomUUID(),
      conversationId: randomUUID(),
      messageId: randomUUID(),
      message,
      createdAt: new Date(this.clock()).toISOString(),
      senderType: 'CUSTOMER',
      messageType: 'TEXT',
    };
    this.active.set(record.messageId, {
      record,
      expires: this.clock() + 60000,
      tools: [],
    });
    return record;
  }
  async current(businessId, conversationId, messageId) {
    const entry = this.active.get(messageId);
    if (
      !entry ||
      entry.expires <= this.clock() ||
      businessId !== this.config.businessId ||
      entry.record.businessId !== businessId ||
      entry.record.conversationId !== conversationId
    )
      throw failure(401, 'INVALID_LOCAL_REQUEST_CONTEXT');
    await this.checkOwner();
    return { ...entry.record };
  }
  async historyBefore() {
    throw failure(503, 'LOCAL_HISTORY_UNAVAILABLE');
  }
  async saveReply() {
    throw failure(503, 'LOCAL_REPLY_PERSISTENCE_UNAVAILABLE');
  }
  close(id) {
    this.active.delete(id);
  }
}

function messageBody(body) {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).join(',') !== 'message' ||
    typeof body.message !== 'string' ||
    !body.message.trim() ||
    Array.from(body.message).length > 2000
  )
    throw failure(400, 'INVALID_LOCAL_MESSAGE');
  return body.message.trim();
}

async function readResponse(response) {
  if (!response.ok || !response.body)
    throw failure(503, 'LOCAL_AI_UNAVAILABLE');
  const reader = response.body.getReader(),
    chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 65536) throw failure(503, 'LOCAL_AI_RESPONSE_INVALID');
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw failure(503, 'LOCAL_AI_RESPONSE_INVALID');
  }
}

async function createHarness(env = process.env) {
  const config = settings(env); // All environment gates run BEFORE any database connection.
  const { PrismaService } = require('../dist/prisma/prisma.service');
  const {
    ProductAccessService,
  } = require('../dist/products/product-access.service');
  const { ProductsService } = require('../dist/products/products.service');
  const { VariantsService } = require('../dist/variants/variants.service');
  const {
    BusinessesService,
  } = require('../dist/businesses/businesses.service');
  const { AiSecurity } = require('../dist/ai/ai-security');
  const { AiService } = require('../dist/ai/ai.service');
  const { validateAiResponse } = require('../dist/ai/ai-response');
  const serviceConfig = new ConfigService({
    ...env,
    DATABASE_URL: config.database,
    AI_BASE_URL: config.origin,
    AI_INTEGRATION_ENABLED: 'true', // This isolated runner only; never saved to production settings.
  });
  const security = new AiSecurity(serviceConfig);
  security.settings();
  class LocalModule {}
  Module({
    imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
    providers: [
      { provide: ConfigService, useValue: serviceConfig },
      PrismaService,
      ProductAccessService,
      ProductsService,
      VariantsService,
      BusinessesService,
    ],
  })(LocalModule);
  const app = await NestFactory.create(LocalModule, {
    logger: false,
    bodyParser: false,
  });
  const controllers = new Set();
  try {
    const prisma = app.get(PrismaService);
    await prisma.$connect();
    // Defend against misconfigured aliases/tunnels in addition to the URL gate.
    const db = await prisma.$queryRawUnsafe(
      'SELECT current_database() AS name',
    );
    if (db[0]?.name !== new URL(config.database).pathname.slice(1))
      throw failure(403, 'LOCAL_DATABASE_IDENTITY_MISMATCH');
    await authorize(prisma, config);
    const registry = new SyntheticRequests(config, () =>
      authorize(prisma, config),
    );
    const ai = new AiService(
      security,
      registry,
      app.get(ProductsService),
      app.get(VariantsService),
      app.get(BusinessesService),
    );
    const http = app.getHttpAdapter().getInstance();
    http.disable('x-powered-by');
    http.use((req, res, next) => {
      const peer = req.socket.remoteAddress;
      let host;
      try {
        host = new URL('http://' + req.headers.host);
      } catch {
        /* rejected below */
      }
      if (
        !['127.0.0.1', '::ffff:127.0.0.1', '::1'].includes(peer) ||
        !host ||
        !LOOPBACK.has(host.hostname) ||
        req.headers.origin ||
        req.headers['access-control-request-method']
      )
        return res.status(403).json({ code: 'LOOPBACK_CLIENT_REQUIRED' });
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Brandora-Test-Mode', 'synthetic-no-history');
      next();
    });
    http.use(express.json({ limit: '16kb', strict: true }));
    const route = (handler) => async (req, res) => {
      try {
        if (
          !/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')
        )
          throw failure(415, 'JSON_REQUIRED');
        await handler(req, res);
      } catch (error) {
        if (!res.headersSent)
          res
            .status(
              [400, 401, 403, 404, 413, 415, 429, 503].includes(error.status)
                ? error.status
                : 503,
            )
            .json({
              code: /^LOCAL_|^INVALID_|^JSON_|^LOOPBACK_/.test(error.code ?? '')
                ? error.code
                : 'LOCAL_REQUEST_UNAVAILABLE',
            });
      }
    };
    http.get('/local/status', (req, res) => {
      if (req.headers['x-brandora-local-test'] !== 'true')
        return res.status(403).json({ code: 'LOCAL_CONFIRMATION_REQUIRED' });
      res.json({
        mode: 'synthetic-no-history',
        dataSource: 'local-postgresql',
        businessId: config.businessId,
        conversationPersistence: false,
        ordersEnabled: false,
      });
    });
    http.post(
      '/dev/ai/respond',
      route(async (req, res) => {
        if (req.headers['x-brandora-local-test'] !== 'true')
          throw failure(403, 'LOCAL_CONFIRMATION_REQUIRED');
        const message = messageBody(req.body);
        await authorize(prisma, config);
        const m = registry.open(message),
          controller = new AbortController();
        controllers.add(controller);
        const timer = setTimeout(() => controller.abort(), 30000);
        const disconnect = () => {
          if (!res.writableEnded) controller.abort();
        };
        res.once('close', disconnect);
        try {
          const body = JSON.stringify({
            businessId: m.businessId,
            customerId: m.customerId,
            conversationId: m.conversationId,
            messageId: m.messageId,
            message: m.message,
          });
          const response = await fetch(config.origin + '/v2/ai/respond', {
            method: 'POST',
            redirect: 'error',
            signal: controller.signal,
            headers: {
              'Content-Type': 'application/json',
              'X-Internal-Token': security.settings().outbound,
              'X-AI-Context': security.issue(m, body),
            },
            body,
          });
          const result = validateAiResponse(await readResponse(response));
          await registry.current(m.businessId, m.conversationId, m.messageId);
          const entry = registry.active.get(m.messageId);
          const understanding = response.headers.get(
            'X-AI-Understanding-Provider',
          );
          const reply = response.headers.get('X-AI-Reply-Provider');
          const provider = (value) =>
            ['groq', 'rules', 'deterministic'].includes(value)
              ? value
              : 'unknown';
          res.setHeader('X-AI-Understanding-Provider', provider(understanding));
          res.setHeader('X-AI-Reply-Provider', provider(reply));
          res.setHeader(
            'X-Brandora-Live-Groq',
            understanding === 'groq' && reply === 'groq' ? 'true' : 'false',
          );
          res.setHeader(
            'X-AI-History-Status',
            ['not_requested', 'unavailable', 'partial', 'complete'].includes(
              response.headers.get('X-AI-History-Status'),
            )
              ? response.headers.get('X-AI-History-Status')
              : 'unknown',
          );
          res.setHeader('X-Brandora-Tool-Calls', entry.tools.join(','));
          res.setHeader('X-Brandora-Backend-Source', 'local-postgresql');
          res.json(result);
        } finally {
          clearTimeout(timer);
          controller.abort();
          controllers.delete(controller);
          registry.close(m.messageId);
          res.off('close', disconnect);
        }
      }),
    );
    http.post(
      '/internal/ai/data',
      route(async (req, res) => {
        const claims = security.authenticate(
          req.headers.authorization,
          req.headers['x-ai-context'],
        );
        const { plainToInstance } = require('class-transformer');
        const { validateSync } = require('class-validator');
        const { AiToolDto } = require('../dist/ai/ai.dto');
        const dto = plainToInstance(AiToolDto, req.body);
        if (
          !req.body ||
          Array.isArray(req.body) ||
          validateSync(dto, { whitelist: true, forbidNonWhitelisted: true })
            .length ||
          !TOOLS.has(dto.tool)
        )
          throw failure(400, 'INVALID_LOCAL_TOOL');
        await registry.current(
          claims.businessId,
          claims.conversationId,
          claims.messageId,
        );
        const result = await ai.tool(claims, dto);
        registry.active.get(claims.messageId)?.tools.push(dto.tool);
        res.json(result);
      }),
    );
    http.use((error, req, res, next) => {
      res
        .status(error.type === 'entity.too.large' ? 413 : 400)
        .json({ code: 'INVALID_LOCAL_JSON' });
    });
    await app.listen(config.port, '127.0.0.1');
    return {
      app,
      registry,
      security,
      config,
      url: 'http://127.0.0.1:' + app.getHttpServer().address().port,
      close: async () => {
        for (const c of controllers) c.abort();
        await app.close();
      },
    };
  } catch (error) {
    await app.close();
    throw error;
  }
}

if (require.main === module) {
  createHarness()
    .then((h) => {
      console.log(
        'Local synthetic AI runner listening at ' +
          h.url +
          '; no conversation persistence.',
      );
      const stop = () =>
        h.close().then(() => {
          process.exitCode = 0;
        });
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    })
    .catch(() => {
      console.error(
        'Local AI runner refused startup; verify the local-only configuration and disposable fixture.',
      );
      process.exitCode = 1;
    });
}
module.exports = {
  createHarness,
  settings,
  localDatabase,
  localOrigin,
  authorize,
  SyntheticRequests,
  messageBody,
  readResponse,
  FIXTURE_EMAIL,
  FIXTURE_NAME,
};
