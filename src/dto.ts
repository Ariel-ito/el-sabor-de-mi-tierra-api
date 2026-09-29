import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsIn,
  IsInt,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
  ValidateIf,
} from "class-validator";
export class LoginDto {
  @ApiProperty() @IsEmail() email!: string;
  @ApiProperty() @IsString() @MaxLength(256) password!: string;
}
export class CustomerDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  @Matches(/\S/)
  name!: string;
  @ApiPropertyOptional()
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @MaxLength(50)
  phone?: string;
  @ApiPropertyOptional()
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
export class SupplierDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  @Matches(/\S/)
  name!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(100) region!: string;
  @ApiPropertyOptional()
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @MaxLength(50)
  phone?: string;
}
export const MONEY = /^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/;
export const QUANTITY = /^(?:0\.50{0,2}|[1-9]\d{0,5}(?:\.(?:0|5)0{0,2})?)$/;
export class ProductDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  @Matches(/\S/)
  name!: string;
  @ApiProperty() @Matches(MONEY) salePrice!: string;
  @ApiProperty() @Matches(MONEY) estimatedCost!: string;
  @ApiProperty() @IsUUID() defaultSupplierId!: string;
}
export class ProductPatchDto {
  @ApiPropertyOptional()
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  @Matches(/\S/)
  name?: string;
  @ApiPropertyOptional()
  @ValidateIf((_o, v) => v !== undefined)
  @Matches(MONEY)
  salePrice?: string;
  @ApiPropertyOptional()
  @ValidateIf((_o, v) => v !== undefined)
  @Matches(MONEY)
  estimatedCost?: string;
  @ApiPropertyOptional()
  @ValidateIf((_o, v) => v !== undefined)
  @IsUUID()
  defaultSupplierId?: string;
  @ApiPropertyOptional()
  @ValidateIf((_o, v) => v !== undefined)
  @IsBoolean()
  active?: boolean;
}
export class RoundDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(150) name!: string;
  @ApiProperty() @IsDateString({ strict: true }) opensAt!: string;
  @ApiProperty() @IsDateString({ strict: true }) closesAt!: string;
}
export class RoundPatchDto {
  @ApiPropertyOptional()
  @ValidateIf((_o, v) => v !== undefined)
  @IsIn(["OPEN", "CLOSED"])
  status?: "OPEN" | "CLOSED";
  @ApiPropertyOptional()
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  @Matches(/\S/)
  name?: string;
  @ApiPropertyOptional()
  @ValidateIf((_o, v) => v !== undefined)
  @IsDateString({ strict: true })
  opensAt?: string;
  @ApiPropertyOptional()
  @ValidateIf((_o, v) => v !== undefined)
  @IsDateString({ strict: true })
  closesAt?: string;
}
export class ItemDto {
  @ApiProperty() @IsUUID() productId!: string;
  @ApiProperty() @IsUUID() supplierId!: string;
  @ApiProperty() @Matches(QUANTITY) quantity!: string;
  @ApiProperty() @Matches(MONEY) unitPrice!: string;
}
export class OrderDto {
  @ApiProperty() @IsUUID() roundId!: string;
  @ApiProperty() @IsUUID() customerId!: string;
  @ApiPropertyOptional()
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @MaxLength(2000)
  notes?: string;
  @ApiProperty({ type: [ItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ItemDto)
  items!: ItemDto[];
}
export class OrderPatchDto {
  @ApiProperty() @IsInt() @Min(1) version!: number;
  @ApiPropertyOptional()
  @ValidateIf((_o, v) => v !== undefined)
  @IsUUID()
  customerId?: string;
  @ApiPropertyOptional()
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @MaxLength(2000)
  notes?: string;
  @ApiPropertyOptional({ type: [ItemDto] })
  @ValidateIf((_o, v) => v !== undefined)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ItemDto)
  items?: ItemDto[];
}
