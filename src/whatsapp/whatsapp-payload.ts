import { MessageType } from '../generated/prisma/client';

/** One customer message, in our own simple shape. */
export interface InboundWhatsAppMessage {
  /** metadata.phone_number_id: the business number at Meta. Tells us which business. */
  phoneNumberId: string;
  /** messages[].from: the customer's number, digits only (wa_id). */
  from: string;
  /** contacts[].profile.name, when WhatsApp sends it. */
  profileName?: string;
  /** messages[].id (wamid...). Unique, so a repeated webhook is stored once. */
  externalMessageId: string;
  messageType: MessageType;
  content: string;
}

/** A delivery report about a message WE sent. */
export interface WhatsAppStatusUpdate {
  phoneNumberId: string;
  externalMessageId: string;
  status: 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';
  /** Meta's error code on failed reports, e.g. 131047 = 24-hour window closed. */
  errorCode?: number;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim().length > 0 ? v : undefined;

/** Meta's message types -> ours. Anything not listed becomes OTHER. */
const TYPES: Record<string, MessageType> = {
  text: MessageType.TEXT,
  image: MessageType.IMAGE,
  audio: MessageType.AUDIO,
  voice: MessageType.AUDIO,
  video: MessageType.VIDEO,
  document: MessageType.DOCUMENT,
  location: MessageType.LOCATION,
};
/** Not something the customer wrote: never stored, never answered. */
const SKIPPED = new Set(['reaction', 'system', 'request_welcome']);

const STATUSES: Record<string, WhatsAppStatusUpdate['status']> = {
  sent: 'SENT',
  delivered: 'DELIVERED',
  read: 'READ',
  failed: 'FAILED',
};

/**
 * Turns Meta's nested webhook into two flat lists. Never throws: anything
 * missing or unknown is skipped, so one odd event cannot make Meta resend
 * the whole webhook again and again.
 */
export function parseWhatsAppWebhook(payload: unknown): {
  messages: InboundWhatsAppMessage[];
  statuses: WhatsAppStatusUpdate[];
} {
  const messages: InboundWhatsAppMessage[] = [];
  const statuses: WhatsAppStatusUpdate[] = [];
  if (!isObj(payload) || payload.object !== 'whatsapp_business_account')
    return { messages, statuses };

  for (const entry of arr(payload.entry)) {
    if (!isObj(entry)) continue;
    for (const change of arr(entry.changes)) {
      if (!isObj(change) || change.field !== 'messages') continue;
      const value = change.value;
      if (!isObj(value) || !isObj(value.metadata)) continue;
      const phoneNumberId = str(value.metadata.phone_number_id);
      if (!phoneNumberId) continue;

      const names = new Map<string, string>();
      for (const c of arr(value.contacts)) {
        if (!isObj(c) || !isObj(c.profile)) continue;
        const waId = str(c.wa_id);
        const name = str(c.profile.name);
        if (waId && name) names.set(waId, name.trim());
      }

      for (const m of arr(value.messages)) {
        if (!isObj(m)) continue;
        const from = str(m.from);
        const id = str(m.id);
        const type = str(m.type) ?? 'unknown';
        if (!from || !/^\d{6,20}$/.test(from) || !id || SKIPPED.has(type))
          continue;
        const messageType = TYPES[type] ?? MessageType.OTHER;
        const content = contentOf(m, type);
        if (!content) continue;
        messages.push({
          phoneNumberId,
          from,
          profileName: names.get(from),
          externalMessageId: id,
          messageType,
          content,
        });
      }

      for (const s of arr(value.statuses)) {
        if (!isObj(s)) continue;
        const id = str(s.id);
        const status = STATUSES[str(s.status) ?? ''];
        if (!id || !status) continue;
        const error = arr(s.errors)[0];
        const code = isObj(error) ? error.code : undefined;
        statuses.push({
          phoneNumberId,
          externalMessageId: id,
          status,
          ...(typeof code === 'number' ? { errorCode: code } : {}),
        });
      }
    }
  }
  return { messages, statuses };
}

/** The text we store. Media is stored as a short label (+ caption) for now. */
function contentOf(m: Obj, type: string): string | undefined {
  if (type === 'text') return isObj(m.text) ? str(m.text.body) : undefined;
  const media = m[type];
  const caption = isObj(media) ? str(media.caption) : undefined;
  if (type === 'location' && isObj(media)) {
    const place = str(media.name) ?? str(media.address);
    return place ? `[location] ${place}` : '[location]';
  }
  return caption ? `[${type}] ${caption}` : `[${type}]`;
}
