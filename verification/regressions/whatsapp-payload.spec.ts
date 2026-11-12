import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseWhatsAppWebhook } from '../../src/whatsapp/whatsapp-payload';

// The fixture is a real-shaped Meta webhook (fake numbers and ids).
const fixture = JSON.parse(
  readFileSync(join(__dirname, '../fixtures/whatsapp-text.json'), 'utf8'),
);
function withMessage(message: Record<string, unknown>) {
  const copy = JSON.parse(JSON.stringify(fixture));
  copy.entry[0].changes[0].value.messages = [
    { from: '201000000001', id: 'wamid.x', timestamp: '1', ...message },
  ];
  return copy;
}

describe('parseWhatsAppWebhook', () => {
  it('reads a text message with the business number and the customer name', () => {
    expect(parseWhatsAppWebhook(fixture)).toEqual({
      messages: [
        {
          phoneNumberId: '106540352242922',
          from: '201000000001',
          profileName: 'Mona',
          externalMessageId:
            'wamid.HBgLMjAxMDAwMDAwMDEVAgASGBQzQTRCNjQ2RjM0QzdCRjM1RjE4OAA=',
          messageType: 'TEXT',
          content: 'التيشيرت الأسود بكام؟',
        },
      ],
      statuses: [],
    });
  });

  it('labels media and keeps the caption', () => {
    const [image] = parseWhatsAppWebhook(
      withMessage({ type: 'image', image: { id: 'm1', caption: 'ده المقاس' } }),
    ).messages;
    expect(image).toMatchObject({
      messageType: 'IMAGE',
      content: '[image] ده المقاس',
    });
    const [voice] = parseWhatsAppWebhook(
      withMessage({ type: 'voice', voice: { id: 'v1' } }),
    ).messages;
    expect(voice).toMatchObject({ messageType: 'AUDIO', content: '[voice]' });
    const [sticker] = parseWhatsAppWebhook(
      withMessage({ type: 'sticker', sticker: { id: 's1' } }),
    ).messages;
    expect(sticker).toMatchObject({
      messageType: 'OTHER',
      content: '[sticker]',
    });
  });

  it('skips reactions, system events and broken messages', () => {
    for (const message of [
      { type: 'reaction', reaction: { emoji: '👍', message_id: 'wamid.y' } },
      { type: 'system', system: { body: 'changed number' } },
      { type: 'text', text: { body: '   ' } },
      { type: 'text', text: { body: 'hi' }, from: '+20 100' },
      { type: 'text', text: { body: 'hi' }, id: undefined },
    ])
      expect(parseWhatsAppWebhook(withMessage(message)).messages).toEqual([]);
  });

  it('reads delivery reports, with Meta error codes on failures', () => {
    const copy = JSON.parse(JSON.stringify(fixture));
    const value = copy.entry[0].changes[0].value;
    delete value.messages;
    value.statuses = [
      { id: 'wamid.a', status: 'delivered' },
      { id: 'wamid.b', status: 'failed', errors: [{ code: 131047 }] },
      { id: 'wamid.c', status: 'deleted' },
    ];
    expect(parseWhatsAppWebhook(copy).statuses).toEqual([
      {
        phoneNumberId: '106540352242922',
        externalMessageId: 'wamid.a',
        status: 'DELIVERED',
      },
      {
        phoneNumberId: '106540352242922',
        externalMessageId: 'wamid.b',
        status: 'FAILED',
        errorCode: 131047,
      },
    ]);
  });

  it('never throws on things that are not WhatsApp webhooks', () => {
    const empty = { messages: [], statuses: [] };
    for (const payload of [
      null,
      'text',
      [],
      { object: 'page' },
      { object: 'whatsapp_business_account', entry: 'x' },
      {
        object: 'whatsapp_business_account',
        entry: [{ changes: [{ field: 'account_update', value: {} }] }],
      },
    ])
      expect(parseWhatsAppWebhook(payload)).toEqual(empty);
  });
});
