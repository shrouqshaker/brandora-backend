import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface RateRule {
  key: string;
  limit: number;
  seconds: number;
}
export interface RateResult {
  allowed: boolean;
  retryAfter: number;
}
export abstract class AuthRateStore {
  abstract consume(rules: RateRule[]): Promise<RateResult>;
}

@Injectable()
export class PostgresAuthRateStore extends AuthRateStore {
  constructor(private readonly prisma: PrismaService) {
    super();
  }
  consume(rules: RateRule[]): Promise<RateResult> {
    return this.prisma.$transaction(
      async (tx) => {
        // Serializes atomic multi-key allocation/counters across every instance.
        // Only sensitive auth operations use this lock, never business requests.
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(421975, 3)::text`;
        // Match Prisma's UTC timestamp(3) fields independently of server TimeZone.
        const [{ now }] = await tx.$queryRaw<
          { now: Date }[]
        >`SELECT (clock_timestamp() AT TIME ZONE 'UTC') AS now`;
        let retryAfter = 0;
        for (const rule of rules) {
          let bucket = await tx.authRateBucket.findUnique({
            where: { key: rule.key },
          });
          if (bucket) {
            bucket = await tx.authRateBucket.update({
              where: { id: bucket.id },
              data:
                bucket.expiresAt <= now
                  ? {
                      count: 1,
                      expiresAt: new Date(now.getTime() + rule.seconds * 1000),
                    }
                  : { count: Math.min(bucket.count + 1, rule.limit + 1) },
            });
          } else {
            const count = await tx.authRateBucket.count();
            const reusable =
              count >= 10000
                ? await tx.authRateBucket.findFirst({
                    where: { expiresAt: { lte: now } },
                    orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
                  })
                : null;
            if (count >= 10000 && !reusable) {
              retryAfter = Math.max(retryAfter, 60);
              continue;
            }
            const data = {
              key: rule.key,
              count: 1,
              expiresAt: new Date(now.getTime() + rule.seconds * 1000),
            };
            bucket = reusable
              ? await tx.authRateBucket.update({
                  where: { id: reusable.id },
                  data,
                })
              : await tx.authRateBucket.create({ data });
          }
          if (bucket.count > rule.limit)
            retryAfter = Math.max(
              retryAfter,
              Math.max(
                1,
                Math.ceil((bucket.expiresAt.getTime() - now.getTime()) / 1000),
              ),
            );
        }
        return { allowed: retryAfter === 0, retryAfter };
      },
      { maxWait: 3000, timeout: 5000 },
    );
  }
}
