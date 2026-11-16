import { IsIn, IsObject, IsUUID } from 'class-validator';

export class AiRespondDto {
  @IsUUID() conversationId!: string;
  @IsUUID() messageId!: string;
}
export class AiToolDto {
  @IsIn([
    'get_products',
    'get_product_details',
    'get_product_variants',
    'get_variant_details',
    'get_conversation_history',
    'get_business_info',
  ])
  tool!: string;
  @IsObject() arguments!: Record<string, unknown>;
}
