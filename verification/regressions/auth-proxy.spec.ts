import { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { AuthRateGuard } from '../../src/auth/auth-rate.guard';

// Simulated peers prove resolver behavior, not Railway provenance. The local
// PostgreSQL verifier separately exercises real sockets and concurrent apps.
describe('Auth proxy trust boundary and address normalization', () => {
  const secret = randomBytes(48).toString('base64');
  const consume = jest.fn().mockResolvedValue({ allowed: true, retryAfter: 0 });
  const guard = (cidrs = '') =>
    new AuthRateGuard(
      { consume },
      new ConfigService({
        JWT_SECRET: secret,
        AUTH_TRUSTED_PROXY_CIDRS: cidrs,
      }),
    );
  const context = (
    peer: string,
    headers: Record<string, string | string[]> = {},
    email = 'owner@example.invalid',
  ) =>
    ({
      getHandler: () => function login() {},
      switchToHttp: () => ({
        getRequest: () => ({
          socket: { remoteAddress: peer },
          headers,
          body: { email },
          ip: '203.0.113.99',
          ips: ['203.0.113.99'],
        }),
        getResponse: () => ({ setHeader: jest.fn() }),
      }),
    }) as unknown as ExecutionContext;
  beforeEach(() => consume.mockClear());

  it('ignores direct forged forwarding, Cloudflare and Railway headers as well as req.ip', async () => {
    const direct = guard();
    await direct.canActivate(context('198.51.100.10'));
    await direct.canActivate(
      context('198.51.100.10', {
        'x-forwarded-for': '203.0.113.1',
        'x-real-ip': '203.0.113.2',
        forwarded: 'for=203.0.113.3',
        'cf-connecting-ip': '203.0.113.4',
        'x-railway-edge': 'not-proof',
        'x-railway-request-id': 'not-proof',
      }),
    );
    expect(consume.mock.calls[0]).toEqual(consume.mock.calls[1]);
  });
  it('ignores malformed and repeated X-Real-IP, including from an explicitly trusted peer', async () => {
    const trusted = guard('192.0.2.10/32');
    await trusted.canActivate(context('192.0.2.10'));
    for (const value of [
      'not-an-ip',
      '198.51.100.1, 203.0.113.2',
      ['198.51.100.1', '203.0.113.2'],
    ]) {
      await trusted.canActivate(context('192.0.2.10', { 'x-real-ip': value }));
      expect(consume.mock.calls.at(-1)).toEqual(consume.mock.calls[0]);
    }
  });
  it('ignores malformed oversized XFF when the peer is outside the trusted CIDRs', async () => {
    const trusted = guard('192.0.2.0/24');
    await trusted.canActivate(context('198.51.100.10'));
    await trusted.canActivate(
      context('198.51.100.10', { 'x-forwarded-for': 'bad'.repeat(500) }),
    );
    expect(consume.mock.calls[0]).toEqual(consume.mock.calls[1]);
  });
  it('parses comma-separated CIDRs, walks from the right and stops at the first untrusted hop', async () => {
    const trusted = guard(' 192.0.2.0/24, , 2001:db8:ffff::/48 ');
    await trusted.canActivate(
      context('192.0.2.10', {
        'x-forwarded-for': '203.0.113.1, 198.51.100.1, 192.0.2.11',
      }),
    );
    await trusted.canActivate(
      context('2001:db8:ffff::10', {
        'x-forwarded-for': 'not-an-ip, 198.51.100.1, 2001:db8:ffff::11',
      }),
    );
    expect(consume.mock.calls[0]).toEqual(consume.mock.calls[1]);
    await trusted.canActivate(
      context('192.0.2.10', { 'x-forwarded-for': '198.51.100.2' }),
    );
    expect(consume.mock.calls[2][0][0].key).not.toBe(
      consume.mock.calls[0][0][0].key,
    );
  });
  it.each([
    'unknown',
    '198.51.100.1:1234',
    '[2001:db8::1]:1234',
    '198.51.100.1, not-an-ip',
  ])(
    'rejects a malformed selected address from a trusted peer: %s',
    async (forwarded) => {
      await expect(
        guard('192.0.2.10/32').canActivate(
          context('192.0.2.10', { 'x-forwarded-for': forwarded }),
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(consume).not.toHaveBeenCalled();
    },
  );
  it('canonicalizes expanded and compressed IPv6 forwarded addresses', async () => {
    const trusted = guard('192.0.2.10/32');
    await trusted.canActivate(
      context('192.0.2.10', {
        'x-forwarded-for': '2001:0db8:0000:0000:0000:0000:0000:0001',
      }),
    );
    await trusted.canActivate(
      context('192.0.2.10', { 'x-forwarded-for': '2001:db8::1' }),
    );
    expect(consume.mock.calls[0]).toEqual(consume.mock.calls[1]);
  });
  it('canonicalizes mapped IPv4 and plain IPv4 peers to the same quota', async () => {
    const direct = guard();
    await direct.canActivate(context('::ffff:198.51.100.10'));
    await direct.canActivate(context('198.51.100.10'));
    expect(consume.mock.calls[0]).toEqual(consume.mock.calls[1]);
  });
  it('shows shared-peer aggregation: different users share IP quota but have separate account keys', async () => {
    const direct = guard();
    await direct.canActivate(
      context(
        '192.0.2.10',
        { 'x-real-ip': '198.51.100.1' },
        'one@example.invalid',
      ),
    );
    await direct.canActivate(
      context(
        '192.0.2.10',
        { 'x-real-ip': '198.51.100.2' },
        'two@example.invalid',
      ),
    );
    expect(consume.mock.calls[0][0][0]).toEqual(consume.mock.calls[1][0][0]);
    expect(consume.mock.calls[0][0][1].key).not.toBe(
      consume.mock.calls[1][0][1].key,
    );
    expect(JSON.stringify(consume.mock.calls)).not.toMatch(
      /192\.0\.2|198\.51\.100|@example/,
    );
  });
});
