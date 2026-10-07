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
  IsNumber,
  IsString,
  IsUUID,
  Matches,
  Max,
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
  @ApiPropertyOptional()
  @ValidateIf((_o, v) => v !== undefined)
  @Matches(/^\+[1-9]\d{0,3}$/)
  phoneCountryCode?: string;

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
  @ApiPropertyOptional()
  @ValidateIf((_o, v) => v !== undefined)
  @Matches(/^\+[1-9]\d{0,3}$/)
  phoneCountryCode?: string;
  @ApiPropertyOptional()
  @ValidateIf((_o, v) => v !== undefined)
  @Matches(/^\+[1-9]\d{0,3}$/)
  deliveryContactCountryCode?: string;
  @ApiPropertyOptional()
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @MaxLength(150)
  deliveryContactName?: string;
  @ApiPropertyOptional()
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @MaxLength(50)
  deliveryContactPhone?: string;

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
  @ApiPropertyOptional()
  @ValidateIf((_o, v) => v !== undefined && v !== null)
  @IsInt()
  @Min(1)
  @Max(3650)
  shelfLifeDays?: number | null;
  @ApiPropertyOptional()
  @ValidateIf((_o, v) => v !== undefined && v !== null)
  @IsInt()
  @Min(0)
  @Max(365)
  warnDays?: number | null;
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
  @ApiPropertyOptional()
  @ValidateIf((_o, v) => v !== undefined && v !== null)
  @IsInt()
  @Min(1)
  @Max(3650)
  shelfLifeDays?: number | null;
  @ApiPropertyOptional()
  @ValidateIf((_o, v) => v !== undefined && v !== null)
  @IsInt()
  @Min(0)
  @Max(365)
  warnDays?: number | null;
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
  @ValidateIf((_o, v) => v !== undefined) @IsIn(["PREORDER", "STOCK"]) source?:
    "PREORDER" | "STOCK";
  @ApiPropertyOptional()
  @ValidateIf((_o, v) => v !== undefined)
  @Matches(MONEY)
  totalAmount?: string;
  @ApiPropertyOptional()
  @ValidateIf((_o, v) => v !== undefined)
  @IsUUID()
  id?: string;
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
  @IsIn(["PICKUP", "DELIVERY"])
  delivery?: "PICKUP" | "DELIVERY";
  @ApiPropertyOptional()
  @ValidateIf((_o, v) => v !== undefined)
  @Matches(MONEY)
  shippingFee?: string;
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
  @IsIn(["PICKUP", "DELIVERY"])
  delivery?: "PICKUP" | "DELIVERY";
  @ApiPropertyOptional()
  @ValidateIf((_o, v) => v !== undefined)
  @Matches(MONEY)
  shippingFee?: string;
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

export class PurchaseLineDto {
  @IsUUID() productId!: string;
  @Matches(QUANTITY) quantity!: string;
  @Matches(MONEY) quotedUnitCost!: string;
}
export class PurchaseDto {
  @ValidateIf((_o, v) => v !== undefined) @IsUUID() id?: string;
  @IsUUID() roundId!: string;
  @IsUUID() supplierId!: string;
  @IsDateString({ strict: true }) orderedAt!: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => PurchaseLineDto)
  items!: PurchaseLineDto[];
}
export class CloseDecisionDto {
  @IsUUID() receiptItemId!: string;
  @IsIn(["LOSS", "SAMPLE", "PERSONAL", "KEEP"])
  reason!: "LOSS" | "SAMPLE" | "PERSONAL" | "KEEP";
  @Matches(QUANTITY) quantity!: string;
}
export class CloseRoundDto {
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => CloseDecisionDto)
  decisions!: CloseDecisionDto[];
}
export class SaleLineDto {
  @IsUUID() productId!: string;
  @Matches(QUANTITY) quantity!: string;
  @Matches(MONEY) unitPrice!: string;
}
export class SalePaymentDto {
  @Matches(MONEY) amount!: string;
  @IsIn(["CASH", "TRANSFER"]) method!: string;
}
export class SaleDto {
  @IsUUID() id!: string;
  // Cycle whose free stock is sold; defaults to that of the oldest free lot.
  @ValidateIf((_o, v) => v !== undefined) @IsUUID() roundId?: string;
  @ValidateIf((_o, v) => v !== undefined) @IsUUID() customerId?: string;
  @IsDateString({ strict: true }) soldAt!: string;
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @MaxLength(2000)
  notes?: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => SaleLineDto)
  items!: SaleLineDto[];
  @ValidateIf((_o, v) => v !== undefined)
  @ValidateNested()
  @Type(() => SalePaymentDto)
  payment?: SalePaymentDto;
}
export class SalePatchDto {
  @IsInt() @Min(1) version!: number;
  // Omitted means Cliente de paso.
  @ValidateIf((_o, v) => v !== undefined) @IsUUID() customerId?: string;
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @MaxLength(2000)
  notes?: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => SaleLineDto)
  items!: SaleLineDto[];
}
export class PurchasePatchDto {
  @IsInt() @Min(1) version!: number;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => PurchaseLineDto)
  items!: PurchaseLineDto[];
}
export class ReceiptLineDto {
  @IsUUID() purchaseItemId!: string;
  @Matches(QUANTITY) quantity!: string;
  @Matches(MONEY) unitCost!: string;
  @Matches(MONEY) unitDiscount!: string;
  // Printed expiry; omitted uses the product's shelf life from receipt.
  @ValidateIf((_o, v) => v !== undefined)
  @IsDateString({ strict: true })
  expiresAt?: string;
}
export class ReceiptDto {
  @IsUUID() id!: string;
  @IsInt() @Min(1) version!: number;
  @IsDateString({ strict: true }) receivedAt!: string;
  @IsString() @MaxLength(150) @Matches(/\S/) invoice!: string;
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @MaxLength(2000)
  notes?: string;
  @Matches(MONEY) globalDiscount!: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ReceiptLineDto)
  items!: ReceiptLineDto[];
}

export class PaymentDto {
  @IsUUID() id!: string;
  @IsInt() @Min(1) version!: number;
  @Matches(MONEY) amount!: string;
  // An amount above the balance keeps the rest as the customer's credit.
  @ValidateIf((_o, v) => v !== undefined)
  @IsBoolean()
  excessToAccount?: boolean;
  @IsIn(["CASH", "TRANSFER"]) method!: string;
  @IsDateString({ strict: true }) paidAt!: string;
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
export class VoidPaymentDto {
  @IsString() @Matches(/\S/) @MaxLength(500) reason!: string;
}
export class DeliveryLineDto {
  @IsUUID() orderItemId!: string;
  @Matches(QUANTITY) quantity!: string;
}
export class DeliveryDto {
  @IsUUID() id!: string;
  @IsInt() @Min(1) version!: number;
  @IsDateString({ strict: true }) deliveredAt!: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => DeliveryLineDto)
  items!: DeliveryLineDto[];
}
export class WithdrawalDto {
  @IsUUID() id!: string;
  @IsUUID() receiptItemId!: string;
  @Matches(QUANTITY) quantity!: string;
  @IsIn(["SAMPLE", "PERSONAL", "LOSS"]) reason!: string;
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
const OPTIONAL = (_o: object, v: unknown) => v !== undefined && v !== null;
export class FinanceCategoryDto {
  @IsString() @MinLength(1) @MaxLength(80) @Matches(/\S/) name!: string;
  @IsIn(["INCOME", "EXPENSE"]) kind!: string;
  @ValidateIf(OPTIONAL) @IsBoolean() inResult?: boolean;
}
export class FinanceCategoryPatchDto {
  @ValidateIf(OPTIONAL)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  @Matches(/\S/)
  name?: string;
  @ValidateIf(OPTIONAL) @IsBoolean() inResult?: boolean;
  @ValidateIf(OPTIONAL) @IsBoolean() active?: boolean;
}
export class MovementDto {
  @IsUUID() id!: string;
  @IsIn(["INCOME", "EXPENSE"]) kind!: string;
  @IsDateString({ strict: true }) date!: string;
  @Matches(MONEY) amount!: string;
  @IsUUID() categoryId!: string;
  @IsString() @MinLength(1) @MaxLength(300) @Matches(/\S/) description!: string;
  @ValidateIf(OPTIONAL) @IsIn(["CASH", "TRANSFER"]) method?: string | null;
  @ValidateIf(OPTIONAL) @IsIn(["BUSINESS", "ARIEL", "MARIA"]) paidBy?: string;
  @ValidateIf(OPTIONAL) @IsIn(["REIMBURSE", "CONTRIBUTE"]) personalMode?:
    string | null;
  @ValidateIf(OPTIONAL) @IsIn(["ARIEL", "MARIA"]) owner?: string | null;
  @ValidateIf(OPTIONAL) @IsUUID() roundId?: string | null;
}
export class MovementPatchDto extends MovementDto {
  @IsInt() @Min(1) version!: number;
}
export class MovementPayDto {
  @IsInt() @Min(1) version!: number;
  @IsDateString({ strict: true }) date!: string;
  @Matches(MONEY) amount!: string;
  @ValidateIf(OPTIONAL) @IsIn(["CASH", "TRANSFER"]) method?: string | null;
  @ValidateIf(OPTIONAL) @IsIn(["BUSINESS", "ARIEL", "MARIA"]) paidBy?: string;
  @ValidateIf(OPTIONAL) @IsIn(["REIMBURSE", "CONTRIBUTE"]) personalMode?:
    string | null;
}
export class ReimburseDto {
  @IsInt() @Min(1) version!: number;
  @IsDateString({ strict: true }) date!: string;
}
export class RecurringDto {
  @IsString() @MinLength(1) @MaxLength(300) @Matches(/\S/) description!: string;
  @IsUUID() categoryId!: string;
  @Matches(MONEY) amount!: string;
  @IsIn(["WEEKLY", "BIWEEKLY", "MONTHLY"]) frequency!: string;
  @IsInt() @Min(0) day!: number;
  @IsDateString({ strict: true }) startsOn!: string;
}
export class RecurringPatchDto extends RecurringDto {
  @IsInt() @Min(1) version!: number;
  @IsBoolean() active!: boolean;
}
export class DistributionDto {
  @IsUUID() id!: string;
  @IsDateString({ strict: true }) date!: string;
  @Matches(MONEY) ariel!: string;
  @Matches(MONEY) maria!: string;
  @ValidateIf(OPTIONAL) @IsIn(["CASH", "TRANSFER"]) method?: string | null;
  @ValidateIf(OPTIONAL)
  @IsString()
  @MaxLength(300)
  description?: string;
}
export class CarryDto {
  @IsInt() @Min(1) version!: number;
  // Null brings the line back to its own cycle.
  @ValidateIf(OPTIONAL) @IsUUID() roundId?: string | null;
}
export class AccountMoveDto {
  @IsUUID() id!: string;
  @Matches(MONEY) amount!: string;
  @IsIn(["CASH", "TRANSFER"]) method!: string;
  @IsDateString({ strict: true }) date!: string;
  @ValidateIf(OPTIONAL) @IsString() @MaxLength(500) notes?: string;
}
export class ApplyCreditDto {
  @IsUUID() id!: string;
  @IsInt() @Min(1) version!: number;
  @Matches(MONEY) amount!: string;
  @IsDateString({ strict: true }) date!: string;
}
export class OrderCreditDto {
  @IsUUID() id!: string;
  @IsInt() @Min(1) version!: number;
}
export class LotExpiryDto {
  // Null clears it.
  @ValidateIf((_o, v) => v !== null)
  @IsDateString({ strict: true })
  expiresAt!: string | null;
}
export class SettingTextDto {
  @IsInt() @Min(1) version!: number;
  @IsString() @MinLength(1) @MaxLength(2000) @Matches(/\S/) value!: string;
}
export class CustomerLocationDto {
  // Both null clear the spot.
  @ValidateIf((_o, v) => v !== null) @IsNumber() @Min(-90) @Max(90) latitude!:
    number | null;
  @ValidateIf((_o, v) => v !== null)
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude!: number | null;
  @ValidateIf(OPTIONAL) @IsString() @MaxLength(500) address?: string | null;
}
export class MapLinkDto {
  @IsString() @MaxLength(2000) url!: string;
}
