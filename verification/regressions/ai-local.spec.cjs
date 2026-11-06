const {
  settings,
  localDatabase,
  localOrigin,
  SyntheticRequests,
  messageBody,
  authorize,
  readResponse,
} = require('../../dev/ai-local.cjs');
const { randomUUID } = require('node:crypto');
const valid = {
  APP_ENV: 'local',
  NODE_ENV: 'development',
  AI_LOCAL_ENABLED: 'true',
  AI_LOCAL_DATABASE_URL:
    'postgresql://postgres@127.0.0.1:55439/brandora_ai_local_' + 'a'.repeat(32),
  AI_LOCAL_BUSINESS_ID: randomUUID(),
  AI_LOCAL_OWNER_ID: randomUUID(),
  AI_BASE_URL: 'http://127.0.0.1:8000',
};
describe('Separate local AI runner security gates', () => {
  test.each([
    { AI_LOCAL_ENABLED: undefined },
    { AI_LOCAL_ENABLED: 'false' },
    { NODE_ENV: 'production' },
    { APP_ENV: 'production' },
    { APP_ENV: 'staging' },
    { RAILWAY_SERVICE_ID: 'any-service' },
    { RAILWAY_ENVIRONMENT_ID: 'any-env' },
    { AI_LOCAL_BUSINESS_ID: undefined },
    { AI_LOCAL_OWNER_ID: 'caller-selected' },
  ])('refuses invalid environment before database access: %j', (patch) => {
    expect(() => settings({ ...valid, ...patch })).toThrow();
  });
  test.each([
    'postgresql://postgres@neon.example/brandora_ai_local_' + 'a'.repeat(32),
    'postgresql://postgres@127.0.0.1/neondb',
    valid.AI_LOCAL_DATABASE_URL + '?host=remote.example',
  ])('refuses non-disposable database targets', (url) => {
    expect(() => localDatabase(url)).toThrow();
  });
  test.each([
    'https://ai.example',
    'http://127.0.0.1:8000/path',
    'http://user:pass@localhost:8000',
    'http://localhost:8000/?remote=true',
  ])('refuses arbitrary callback origins', (url) =>
    expect(() => localOrigin(url)).toThrow(),
  );
  test.each([
    {},
    { message: ' ' },
    { message: 'x'.repeat(2001) },
    { message: 'hi', businessId: randomUUID() },
    { message: 'hi', history: [] },
    { message: ['hi'] },
  ])('accepts only independent message text', (body) => {
    expect(() => messageBody(body)).toThrow();
  });
  test('synthetic context is short-lived, scoped and discarded after a request', async () => {
    let now = Date.now();
    const check = jest.fn().mockResolvedValue(undefined);
    const registry = new SyntheticRequests(settings(valid), check, () => now);
    const m = registry.open('test message');
    expect(
      await registry.current(m.businessId, m.conversationId, m.messageId),
    ).toEqual(m);
    expect(check).toHaveBeenCalledTimes(1);
    await expect(
      registry.current(randomUUID(), m.conversationId, m.messageId),
    ).rejects.toThrow();
    await expect(
      registry.current(m.businessId, randomUUID(), m.messageId),
    ).rejects.toThrow();
    await expect(registry.historyBefore()).rejects.toThrow(
      'LOCAL_HISTORY_UNAVAILABLE',
    );
    await expect(registry.saveReply()).rejects.toThrow(
      'LOCAL_REPLY_PERSISTENCE_UNAVAILABLE',
    );
    now += 60000;
    await expect(
      registry.current(m.businessId, m.conversationId, m.messageId),
    ).rejects.toThrow();
    registry.close(m.messageId);
    expect(registry.active.size).toBe(0);
  });
  test('revalidates the configured fixture owner and refuses other data', async () => {
    const prisma = {
      businessMember: {
        findUnique: jest.fn().mockResolvedValue({
          role: 'OWNER',
          isActive: true,
          user: { email: 'real-owner@example.com' },
          business: { name: 'Real business' },
        }),
      },
    };
    await expect(authorize(prisma, settings(valid))).rejects.toThrow(
      'LOCAL_FIXTURE_AUTHORIZATION_FAILED',
    );
  });
  test('bounds simultaneous synthetic requests without accumulating conversations', () => {
    const registry = new SyntheticRequests(settings(valid), async () => {});
    for (let i = 0; i < 4; i++) registry.open('message');
    expect(() => registry.open('over capacity')).toThrow('LOCAL_RUNNER_BUSY');
  });
  test.each([
    () => new Response('private provider details', { status: 503 }),
    () => new Response('invalid JSON'),
    () => new Response('x'.repeat(65537)),
  ])(
    'sanitizes provider failures, malformed JSON and oversized responses',
    async (response) => {
      await expect(readResponse(response())).rejects.toMatchObject({
        status: 503,
      });
    },
  );
});
