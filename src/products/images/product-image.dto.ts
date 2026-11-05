import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  Equals,
  IsArray,
  IsUUID,
} from 'class-validator';
// Uploads accept files only: no Color/Size/Weight or Variant association.
export class ProductImageDto {}
export class ProductImageOrderDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  imageIds!: string[];
}
export class ProductImageMainDto {
  @Equals(true)
  isMain!: true;
}
