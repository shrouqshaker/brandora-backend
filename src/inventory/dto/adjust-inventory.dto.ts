import { IsBoolean, ValidateBy, ValidateIf } from 'class-validator';

export class AdjustInventoryDto {
  @ValidateIf((_o, v) => v !== undefined)
  @IsBoolean()
  trackInventory?: boolean;

  @ValidateBy({
    name: 'inventoryQuantity',
    validator: {
      validate: (value, args) =>
        (args!.object as AdjustInventoryDto).trackInventory === false
          ? value === null
          : typeof value === 'number' &&
            Number.isInteger(value) &&
            value >= 0 &&
            value <= 2147483647,
      defaultMessage: () =>
        'quantity must be an integer from 0 to 2147483647 when tracked, or explicit null when tracking is disabled',
    },
  })
  quantity!: number | null;
}
