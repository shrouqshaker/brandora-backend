import { IsUUID } from 'class-validator';

export class CatalogItemScopeDto {
  @IsUUID()
  businessId!: string;
}
