import { IsInt, Max, Min } from 'class-validator';

export class AdjustInventoryDto {
  @IsInt()
  @Min(0)
  @Max(2147483647)
  quantity!: number;
}
