import { isUUID } from 'class-validator';

export interface AiResponse {
  intent: 'INQUIRY' | 'PURCHASE_INTENT' | 'CONFIRMED_ORDER' | 'OTHER';
  reply: string;
  requiresReview: boolean;
  orderCandidate: null;
}

export function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
export function identifier(value: unknown): value is string {
  return (
    typeof value === 'string' && isUUID(value) && value === value.toLowerCase()
  );
}

// E0-3 fields are preserved. Orders do not exist here, so no candidate or action
// can be accepted by this read-only integration, regardless of model claims.
export function validateAiResponse(value: unknown): AiResponse {
  if (
    !object(value) ||
    Object.keys(value).sort().join(',') !==
      'intent,orderCandidate,reply,requiresReview' ||
    typeof value.intent !== 'string' ||
    !['INQUIRY', 'PURCHASE_INTENT', 'OTHER'].includes(value.intent) ||
    typeof value.reply !== 'string' ||
    !value.reply.trim() ||
    Array.from(value.reply).length > 20000 ||
    typeof value.requiresReview !== 'boolean' ||
    value.orderCandidate !== null
  )
    throw new Error('Invalid AI response');
  return value as unknown as AiResponse;
}
