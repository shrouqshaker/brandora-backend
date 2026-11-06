import { HttpStatus, Injectable } from '@nestjs/common';
import { AppHttpException } from '../common/errors/app-http.exception';
import { ErrorCode } from '../common/errors/error-code';
import { ProductsService } from '../products/products.service';
import { VariantsService } from '../variants/variants.service';
import { BusinessesService } from '../businesses/businesses.service';
import { AiConversationStore, AiMessage } from './ai-conversation.store';
import {
  AiClaims,
  AiSecurity,
  denied,
  digest,
  same,
  unavailable,
} from './ai-security';
import { AiRespondDto, AiToolDto } from './ai.dto';
import { identifier, object, validateAiResponse } from './ai-response';

const invalid = () =>
  new AppHttpException(
    ErrorCode.VALIDATION_ERROR,
    HttpStatus.BAD_REQUEST,
    'Invalid AI tool arguments',
  );
const KEYS: Record<string, [string[], string[]]> = {
  get_products: [[], ['limit', 'offset']],
  get_product_details: [['productId'], []],
  get_product_variants: [['productId'], ['limit', 'offset']],
  get_variant_details: [['productId', 'variantId'], []],
  get_conversation_history: [['conversationId'], ['limit', 'offset']],
  get_business_info: [[], []],
};

@Injectable()
export class AiService {
  constructor(
    private readonly security: AiSecurity,
    private readonly conversations: AiConversationStore,
    private readonly products: ProductsService,
    private readonly variants: VariantsService,
    private readonly businesses: BusinessesService,
  ) {}

  private body(message: AiMessage) {
    return JSON.stringify({
      businessId: message.businessId,
      customerId: message.customerId,
      conversationId: message.conversationId,
      messageId: message.messageId,
      message: message.message,
    });
  }
  private async current(
    businessId: string,
    conversationId: string,
    messageId: string,
  ) {
    const m = await this.conversations.current(
      businessId,
      conversationId,
      messageId,
    );
    if (
      !m ||
      m.businessId !== businessId ||
      m.conversationId !== conversationId ||
      m.messageId !== messageId ||
      ![m.businessId, m.customerId, m.conversationId, m.messageId].every(
        identifier,
      ) ||
      typeof m.message !== 'string' ||
      m.senderType !== 'CUSTOMER' ||
      m.messageType !== 'TEXT' ||
      !m.message.trim() ||
      Array.from(m.message).length > 2000 ||
      typeof m.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(m.createdAt))
    )
      throw denied();
    return m;
  }

  async respond(businessId: string, dto: AiRespondDto) {
    const settings = this.security.settings();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const m = await this.current(
        businessId,
        dto.conversationId,
        dto.messageId,
      );
      const body = this.body(m);
      const context = this.security.issue(m, body);
      const response = await fetch(settings.origin + '/v2/ai/respond', {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': settings.outbound,
          'X-AI-Context': context,
        },
        body,
      });
      if (!response.ok || !response.body) throw unavailable();
      const reader = response.body.getReader();
      const parts: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 65536) throw unavailable();
        parts.push(value);
      }
      const result = validateAiResponse(
        JSON.parse(Buffer.concat(parts).toString('utf8')),
      );
      // Re-attest after the external call. The store must reject edits/replays and
      // save at most one AI reply per source message in its own short transaction.
      const current = await this.current(
        businessId,
        dto.conversationId,
        dto.messageId,
      );
      if (!same(this.body(current), body) || current.createdAt !== m.createdAt)
        throw denied();
      return validateAiResponse(await this.conversations.saveReply(m, result));
    } catch (error) {
      if (error instanceof AppHttpException) throw error;
      throw unavailable();
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  async tool(claims: AiClaims, dto: AiToolDto) {
    const spec = KEYS[dto.tool];
    const args = dto.arguments;
    if (
      !spec ||
      !object(args) ||
      !spec[0].every((k) => k in args) ||
      Object.keys(args).some((k) => ![...spec[0], ...spec[1]].includes(k)) ||
      !spec[0].every((k) => identifier(args[k]))
    )
      throw invalid();
    const limit = args.limit ?? 20,
      offset = args.offset ?? 0;
    if (
      spec[1].length &&
      (!Number.isSafeInteger(limit) ||
        Number(limit) < 1 ||
        Number(limit) > 100 ||
        !Number.isSafeInteger(offset) ||
        Number(offset) < 0)
    )
      throw invalid();
    if (
      dto.tool === 'get_conversation_history' &&
      args.conversationId !== claims.conversationId
    )
      throw denied();
    try {
      const m = await this.current(
        claims.businessId,
        claims.conversationId,
        claims.messageId,
      );
      if (
        m.customerId !== claims.customerId ||
        !same(digest(this.body(m)), claims.requestHash)
      )
        throw denied();
      const page = { limit: Number(limit), offset: Number(offset) };
      let data: unknown;
      switch (dto.tool) {
        case 'get_products':
          data = await this.products.list(claims.businessId, page);
          break;
        case 'get_product_details':
          data = await this.products.get(
            claims.businessId,
            args.productId as string,
          );
          break;
        case 'get_product_variants':
          data = await this.variants.list(
            claims.businessId,
            args.productId as string,
            page,
          );
          break;
        case 'get_variant_details':
          data = await this.variants.get(
            claims.businessId,
            args.productId as string,
            args.variantId as string,
          );
          break;
        case 'get_business_info':
          data = {
            business: await this.businesses.get(claims.businessId),
            settings: await this.businesses.settings(claims.businessId),
            workingHours: await this.businesses.hours(claims.businessId),
          };
          break;
        case 'get_conversation_history':
          data = await this.conversations.historyBefore(
            m,
            page.limit,
            page.offset,
          );
          this.history(data, m, page);
          break;
        default:
          throw invalid();
      }
      const result = { tool: dto.tool, data };
      if (Buffer.byteLength(JSON.stringify(result)) > 131072)
        throw unavailable('AI data response exceeds its limit');
      return result;
    } catch (error) {
      if (error instanceof AppHttpException) throw error;
      throw unavailable();
    }
  }

  private history(
    value: unknown,
    m: AiMessage,
    page: { limit: number; offset: number },
  ) {
    if (
      !object(value) ||
      value.businessId !== m.businessId ||
      value.customerId !== m.customerId ||
      value.conversationId !== m.conversationId ||
      value.beforeMessageId !== m.messageId ||
      value.beforeMessageCreatedAt !== m.createdAt ||
      value.order !== 'createdAt_desc_id_desc' ||
      typeof value.snapshot !== 'string' ||
      !value.snapshot ||
      value.snapshot.length > 128 ||
      typeof value.complete !== 'boolean' ||
      !object(value.pagination) ||
      value.pagination.limit !== page.limit ||
      value.pagination.offset !== page.offset ||
      !Number.isSafeInteger(value.pagination.totalCount) ||
      Number(value.pagination.totalCount) < 0 ||
      typeof value.pagination.hasMore !== 'boolean' ||
      !Array.isArray(value.items) ||
      value.items.length > page.limit ||
      (value.pagination.hasMore
        ? !value.items.length ||
          value.pagination.nextOffset !== page.offset + value.items.length
        : value.pagination.nextOffset !== null)
    )
      throw unavailable('Invalid conversation history');
    let previous = { time: Date.parse(m.createdAt), id: m.messageId };
    const seen = new Set<string>();
    const customerTimes = new Set<number>();
    for (const row of value.items) {
      if (
        !object(row) ||
        !identifier(row.id) ||
        seen.has(row.id) ||
        row.id === m.messageId ||
        row.conversationId !== m.conversationId ||
        !['CUSTOMER', 'AI', 'OWNER'].includes(row.senderType as string) ||
        ![
          'TEXT',
          'IMAGE',
          'AUDIO',
          'VIDEO',
          'DOCUMENT',
          'LOCATION',
          'OTHER',
        ].includes(row.messageType as string) ||
        (row.content !== null &&
          (typeof row.content !== 'string' ||
            Array.from(row.content).length > 2000)) ||
        typeof row.createdAt !== 'string' ||
        !Number.isFinite(Date.parse(row.createdAt))
      )
        throw unavailable('Invalid conversation history');
      const time = Date.parse(row.createdAt);
      if (
        // UUID order is deterministic presentation, not proof of causality.
        // Exclude the entire source timestamp, matching canonical AI history.
        time >= Date.parse(m.createdAt) ||
        time > previous.time ||
        (time === previous.time && row.id >= previous.id) ||
        (row.senderType === 'CUSTOMER' && customerTimes.has(time))
      )
        throw unavailable('Invalid conversation history');
      if (row.senderType === 'CUSTOMER') customerTimes.add(time);
      seen.add(row.id);
      previous = { time, id: row.id };
    }
  }
}
