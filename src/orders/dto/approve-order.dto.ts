import { IsBoolean, IsOptional } from 'class-validator';

export class ApproveOrderDto {
  /**
   * Optional. A price changed since the order was made: false (default) =
   * 409 ORDER_PRICE_CHANGED and nothing changes; true = approve at today's
   * prices (the order keeps them as its new price snapshot).
   */
  @IsOptional()
  @IsBoolean()
  acceptCurrentPrices?: boolean;
}
