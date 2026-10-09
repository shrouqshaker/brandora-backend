export interface Pagination {
  limit: number;
  offset: number;
  totalCount: number;
  hasMore: boolean;
  nextOffset: number | null;
}

export function createPagination(
  { limit, offset }: Pick<Pagination, 'limit' | 'offset'>,
  totalCount: number,
): Pagination {
  // Subtraction avoids overflowing a safe offset when adding the page limit.
  const hasMore = offset < totalCount && totalCount - offset > limit;
  return {
    limit,
    offset,
    totalCount,
    hasMore,
    nextOffset: hasMore ? offset + limit : null,
  };
}
