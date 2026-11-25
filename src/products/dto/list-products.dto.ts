import { IsOptional, IsUUID } from 'class-validator';
import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto';

export class ListProductsDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID()
  categoryId?: string;
}
