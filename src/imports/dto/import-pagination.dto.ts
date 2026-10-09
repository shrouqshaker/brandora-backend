import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto';

export class ImportPaginationDto extends PaginationQueryDto {
  limit = 50;
}

export class ImportHistoryPaginationDto extends ImportPaginationDto {
  limit = 20;
}
