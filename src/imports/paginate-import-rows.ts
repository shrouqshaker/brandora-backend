import { ImportPaginationDto } from './dto/import-pagination.dto';

export type { Pagination as ImportPagination } from '../common/pagination/pagination';
export { createPagination as importPagination } from '../common/pagination/pagination';

/** One page across all non-skipped rows, ordered by original Excel row number. */
export function importPageRowNumbers(
  collections: ReadonlyArray<ReadonlyArray<{ rowNumber: number }>>,
  pagination: ImportPaginationDto,
): Set<number> {
  const rowNumbers = collections
    .flatMap((rows) => rows.map((row) => row.rowNumber))
    .sort((a, b) => a - b);
  return new Set(
    rowNumbers.slice(pagination.offset, pagination.offset + pagination.limit),
  );
}
