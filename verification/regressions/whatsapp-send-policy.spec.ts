import { Logger } from '@nestjs/common';
import { MessagesService } from '../../src/messages/messages.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { WhatsAppConnectionsService } from '../../src/whatsapp/whatsapp-connections.service';
import { WhatsAppSenderService } from '../../src/whatsapp/whatsapp-sender.service';
import { WhatsAppSettings } from '../../src/whatsapp/whatsapp-settings';

// Which answers from Meta lead to another try. fetch is mocked here; the
// whole path with the database is in verification/whatsapp-postgres.cjs.
const BUSINESS = 'a0000000-0000-4000-8000-000000000001';
const MESSAGE = 'b0000000-0000-4000-8000-000000000001';

function sender() {
  const prisma = {
    message: {
      findFirst: jest.fn().mockResolvedValue({
        id: MESSAGE,
        status: 'PENDING',
        content: 'تمام',
        conversation: { customer: { phone: '201000000001' } },
      }),
    },
  };
  const messages = {
    claimForSending: jest.fn().mockResolvedValue(1),
    markSendResult: jest.fn().mockResolvedValue({ id: MESSAGE }),
  };
  const connections = {
    activePhoneNumberIdFor: jest.fn().mockResolvedValue('106540352242922'),
  };
  const settings = {
    sending: () => ({
      dryRun: false,
      accessToken: 'test-token-1234567890',
      graphVersion: 'v26.0',
    }),
  };
  const service = new WhatsAppSenderService(
    prisma as unknown as PrismaService,
    messages as unknown as MessagesService,
    connections as unknown as WhatsAppConnectionsService,
    settings as unknown as WhatsAppSettings,
  );
  return { service, messages };
}

const metaAnswers = (status: number, json: unknown) =>
  jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify(json), { status }));
const fetchThrows = (error: unknown) =>
  jest.spyOn(globalThis, 'fetch').mockRejectedValue(error);

beforeEach(() =>
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined),
);
afterEach(() => jest.restoreAllMocks());

describe('WhatsAppSenderService retry policy', () => {
  it('SENT with the wamid when Meta accepts the message', async () => {
    metaAnswers(200, { messages: [{ id: 'wamid.ok' }] });
    const { service, messages } = sender();
    await service.deliver(BUSINESS, MESSAGE);
    expect(messages.markSendResult).toHaveBeenCalledWith(
      BUSINESS,
      MESSAGE,
      { externalMessageId: 'wamid.ok' },
      1,
    );
  });

  it.each([429, 500, 503])(
    'RETRY when Meta answers %i (nothing was sent)',
    async (status) => {
      metaAnswers(status, { error: { code: 4, message: 'busy' } });
      const { service, messages } = sender();
      await service.deliver(BUSINESS, MESSAGE);
      expect(messages.markSendResult.mock.calls[0][2]).toBe('RETRY');
    },
  );

  it.each([400, 401, 403])(
    'FAILED at once when Meta refuses with %i',
    async (status) => {
      metaAnswers(status, { error: { code: 131047, message: 'window' } });
      const { service, messages } = sender();
      await service.deliver(BUSINESS, MESSAGE);
      expect(messages.markSendResult.mock.calls[0][2]).toBe('FAILED');
    },
  );

  it('RETRY when the connection never opened', async () => {
    fetchThrows(
      Object.assign(new TypeError('fetch failed'), {
        cause: { code: 'ECONNREFUSED' },
      }),
    );
    const { service, messages } = sender();
    await service.deliver(BUSINESS, MESSAGE);
    expect(messages.markSendResult.mock.calls[0][2]).toBe('RETRY');
  });

  it('FAILED after a timeout: Meta may have sent it, so never twice', async () => {
    fetchThrows(
      new DOMException(
        'The operation was aborted due to timeout',
        'TimeoutError',
      ),
    );
    const { service, messages } = sender();
    await service.deliver(BUSINESS, MESSAGE);
    expect(messages.markSendResult.mock.calls[0][2]).toBe('FAILED');
  });

  it('does not call Meta when another run holds the message', async () => {
    const fetch = metaAnswers(200, { messages: [{ id: 'wamid.ok' }] });
    const { service, messages } = sender();
    messages.claimForSending.mockResolvedValue(null);
    await service.deliver(BUSINESS, MESSAGE);
    expect(fetch).not.toHaveBeenCalled();
    expect(messages.markSendResult).not.toHaveBeenCalled();
  });
});
