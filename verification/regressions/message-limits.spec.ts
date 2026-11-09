import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { InboundMessageDto } from '../../src/conversations/dto/inbound-message.dto';
import {
  AI_MAX_CUSTOMER_TEXT_CHARACTERS,
  characterCount,
  fitsAiLimit,
  MESSAGE_MAX_CHARACTERS,
} from '../../src/messages/message-limits';

// Pure validation, no database. The PostgreSQL round trip is checked in
// verification/conversations-postgres.cjs (test 7).
describe('message length policy (Unicode code points)', () => {
  it('counts Arabic, emoji, skin tones and variation selectors as code points', () => {
    expect(characterCount('مرحبا')).toBe(5);
    expect(characterCount('😀')).toBe(1); // 2 UTF-16 units, 1 code point
    expect(characterCount('👍🏽')).toBe(2); // emoji + skin tone
    expect(characterCount('❤️')).toBe(2); // heart + variation selector
    expect(MESSAGE_MAX_CHARACTERS).toBe(4096);
    expect(AI_MAX_CUSTOMER_TEXT_CHARACTERS).toBe(2000);
  });

  it('marks text longer than 2000 code points as too long for the AI', () => {
    expect(fitsAiLimit('م'.repeat(2000))).toBe(true);
    expect(fitsAiLimit('م'.repeat(2001))).toBe(false);
    expect(fitsAiLimit('😀'.repeat(2000))).toBe(true);
    expect(fitsAiLimit('❤️'.repeat(1001))).toBe(false); // 2002 code points
  });

  const errorsFor = async (content: string) => {
    const dto = plainToInstance(InboundMessageDto, {
      phone: '201000000001',
      content,
    });
    return (await validate(dto)).map((e) => e.property);
  };

  it.each([
    ['Arabic', 'م'.repeat(4096)],
    ['emoji', '😀'.repeat(4096)],
    ['emoji with skin tone', '👍🏽'.repeat(2048)],
    ['heart with variation selector', '❤️'.repeat(2048)],
  ])('accepts exactly 4096 code points of %s', async (_, content) => {
    expect(await errorsFor(content)).toEqual([]);
  });

  it.each([
    ['Arabic', 'م'.repeat(4097)],
    ['emoji', '😀'.repeat(4097)],
    ['heart with variation selector', '❤️'.repeat(2049)],
  ])('rejects 4097 code points of %s', async (_, content) => {
    expect(await errorsFor(content)).toEqual(['content']);
  });
});
