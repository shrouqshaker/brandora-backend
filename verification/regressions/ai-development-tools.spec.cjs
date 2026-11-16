const { localOrigin, replay } = require('../replay-ai-postman.cjs');
const {
  validateSelection,
  checkContents,
  FILES,
} = require('../../dev/package-ai-handoff.cjs');
describe('Reusable local AI development tools', () => {
  test.each([
    'https://production.example',
    'http://127.0.0.1/path',
    'http://user:pass@localhost:3099',
    'http://127.0.0.1/?remote=1',
  ])('collection replay rejects nonlocal or ambiguous origins', (url) => {
    expect(() => localOrigin(url)).toThrow();
  });
  test('replays the exact collection with scope and history denial cases', async () => {
    const transport = jest.fn(async (_url, options) => {
      const body = JSON.parse(options.body);
      const expected =
        options.headers['X-Brandora-Local-Test'] !== 'true'
          ? 403
          : Object.keys(body).some((k) => k !== 'message') ||
              !body.message.trim()
            ? 400
            : 200;
      return new Response(
        JSON.stringify(
          expected === 200
            ? {
                intent: 'INQUIRY',
                reply: 'synthetic',
                requiresReview: false,
                orderCandidate: null,
              }
            : { code: 'SYNTHETIC_ERROR' },
        ),
        {
          status: expected,
          headers: {
            'X-Brandora-Test-Mode': 'synthetic-no-history',
            'X-AI-History-Status': 'unavailable',
            'X-Brandora-Live-Groq': 'false',
          },
        },
      );
    });
    const result = await replay('http://127.0.0.1:3099', transport);
    expect(result.passed).toBe(13);
    expect(transport).toHaveBeenCalledTimes(13);
  });
  test('handoff excludes private env files, history and unreviewed paths', () => {
    expect(() => validateSelection(FILES)).not.toThrow();
    for (const f of [
      '.env',
      '.env.local',
      '.git/config',
      '../private.key',
      '.tmp/snapshot.py',
    ])
      expect(() => validateSelection([f])).toThrow();
    expect(() => validateSelection([FILES[0], FILES[0]])).toThrow();
  });
  test('handoff refuses populated secret examples', () => {
    expect(() =>
      checkContents('.env.example', 'GROQ_API_KEY=\n'),
    ).not.toThrow();
    expect(() =>
      checkContents('.env.example', 'GROQ_API_KEY=synthetic-populated-value\n'),
    ).toThrow();
  });
});
