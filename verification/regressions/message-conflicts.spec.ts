import { AppHttpException } from '../../src/common/errors/app-http.exception';
import { ConversationsService } from '../../src/conversations/conversations.service';
import { CustomersService } from '../../src/customers/customers.service';
import { MessagesService } from '../../src/messages/messages.service';
import { PrismaService } from '../../src/prisma/prisma.service';

// Prisma is mocked, so these two rare paths can be forced. Real races are
// checked in verification/conversations-postgres.cjs (tests 3 and 6).
const BUSINESS = 'a0000000-0000-4000-8000-000000000001';
const uniqueViolation = () =>
  Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });

describe('ingestInboundMessage when a race outlasts the retry', () => {
  it('answers 409 CONFLICT, never a 500', async () => {
    const prisma = {
      business: { findUnique: jest.fn().mockResolvedValue({ id: BUSINESS }) },
      message: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn().mockRejectedValue(uniqueViolation()),
    };
    const service = new ConversationsService(
      prisma as unknown as PrismaService,
      {} as CustomersService,
      {} as MessagesService,
    );
    const error = await service
      .ingestInboundMessage({
        businessId: BUSINESS,
        phone: '201000000001',
        externalMessageId: 'wamid.race',
        content: 'Hi',
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppHttpException);
    expect((error as AppHttpException).getStatus()).toBe(409);
    expect((error as AppHttpException).code).toBe('CONFLICT');
    expect(prisma.$transaction).toHaveBeenCalledTimes(2); // first try + one retry
  });
});

describe('MessagesService.markSendResult', () => {
  it('answers 409 EXTERNAL_MESSAGE_ID_CONFLICT when the WhatsApp id is already stored', async () => {
    const prisma = {
      message: {
        updateMany: jest.fn().mockRejectedValue(uniqueViolation()),
        findFirstOrThrow: jest.fn(),
      },
    };
    const service = new MessagesService(prisma as unknown as PrismaService);
    const error = await service
      .markSendResult(BUSINESS, 'message-id', { externalMessageId: 'wamid.x' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppHttpException);
    expect((error as AppHttpException).getStatus()).toBe(409);
    expect((error as AppHttpException).code).toBe(
      'EXTERNAL_MESSAGE_ID_CONFLICT',
    );
    expect(prisma.message.findFirstOrThrow).not.toHaveBeenCalled();
  });
});
