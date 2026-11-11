import { HttpStatus } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppHttpException } from '../../src/common/errors/app-http.exception';
import { ErrorCode } from '../../src/common/errors/error-code';
import { InboundWebhookService } from '../../src/whatsapp/inbound-webhook.service';

// Which errors are skipped and which make Meta send the webhook again.
// No database: the happy path is tested in whatsapp-postgres.cjs.
const webhook = JSON.parse(
  readFileSync(join(__dirname, '../fixtures/whatsapp-text.json'), 'utf8'),
) as unknown;

function serviceThatFailsWith(error: unknown) {
  const connections = { activeBusinessFor: jest.fn(async () => 'biz-1') };
  const conversations = {
    ingestInboundMessage: jest.fn(async () => {
      throw error;
    }),
  };
  const messages = { updateDeliveryStatus: jest.fn() };
  return new InboundWebhookService(
    connections as never,
    conversations as never,
    messages as never,
  );
}

describe('InboundWebhookService errors', () => {
  it('skips what a retry cannot fix, so Meta still gets 200', async () => {
    for (const code of [
      ErrorCode.INVALID_PHONE_NUMBER,
      ErrorCode.EXTERNAL_MESSAGE_ID_CONFLICT,
    ]) {
      const service = serviceThatFailsWith(
        new AppHttpException(code, HttpStatus.BAD_REQUEST, 'permanent'),
      );
      await expect(service.store(webhook)).resolves.toEqual([]);
    }
  });

  it('throws temporary failures, so Meta sends the webhook again', async () => {
    const race = new AppHttpException(
      ErrorCode.CONFLICT,
      HttpStatus.CONFLICT,
      'concurrent change; retry the request',
    );
    await expect(serviceThatFailsWith(race).store(webhook)).rejects.toBe(race);
    const databaseDown = new Error('Connection refused');
    await expect(
      serviceThatFailsWith(databaseDown).store(webhook),
    ).rejects.toBe(databaseDown);
  });
});