import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import { audit, AuthGuard, AuthRequest, Db } from "./core";
import { CustomerDto, ProductDto, ProductPatchDto, SupplierDto } from "./dto";
import { money } from "./math";
@ApiBearerAuth()
@Controller()
@UseGuards(AuthGuard)
export class CatalogController {
  constructor(@Inject(Db) private db: Db) {}
  @Patch("customers/:id") async patchCustomer(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: CustomerDto,
    @Req() req: AuthRequest,
  ) {
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Customer" WHERE id=${id}::uuid FOR UPDATE`;
      const before = await tx.customer.findUniqueOrThrow({ where: { id } });
      const after = await tx.customer.update({ where: { id }, data: body });
      await audit(tx, req.actor.id, "Customer", id, "UPDATE", before, after);
      return after;
    });
  }
  @Get("customers") customers() {
    return this.db.customer.findMany({ orderBy: { name: "asc" } });
  }
  @Post("customers") createCustomer(@Body() body: CustomerDto) {
    return this.db.customer.create({ data: body });
  }
  @Patch("suppliers/:id") async patchSupplier(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: SupplierDto,
    @Req() req: AuthRequest,
  ) {
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Supplier" WHERE id=${id}::uuid FOR UPDATE`;
      const before = await tx.supplier.findUniqueOrThrow({ where: { id } });
      const after = await tx.supplier.update({ where: { id }, data: body });
      await audit(tx, req.actor.id, "Supplier", id, "UPDATE", before, after);
      return after;
    });
  }
  @Get("suppliers") suppliers() {
    return this.db.supplier.findMany({ orderBy: { name: "asc" } });
  }
  @Post("suppliers") createSupplier(@Body() body: SupplierDto) {
    return this.db.supplier.create({ data: body });
  }
  private product(p: any) {
    const { components, ...rest } = p;
    return {
      ...rest,
      salePrice: money(p.salePrice),
      estimatedCost: money(p.estimatedCost),
      components: (components ?? []).map((c: any) => ({
        componentId: c.componentId,
        name: c.component.name,
        unit: c.component.unit,
        quantity: c.quantity.toString(),
      })),
    };
  }
  @Get("products") async products() {
    return (
      await this.db.product.findMany({
        include: {
          defaultSupplier: true,
          components: { include: { component: true } },
        },
        orderBy: { name: "asc" },
      })
    ).map((p) => this.product(p));
  }
  @Post("products") async createProduct(@Body() body: ProductDto) {
    return this.product(
      await this.db.product.create({
        data: body,
        include: { defaultSupplier: true },
      }),
    );
  }
  @Patch("products/:id") async patchProduct(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: ProductPatchDto,
    @Req() req: AuthRequest,
  ) {
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Product" WHERE id=${id}::uuid FOR UPDATE`;
      const before = await tx.product.findUniqueOrThrow({ where: { id } });
      // Quantities already recorded would change meaning.
      if (
        body.unit &&
        body.unit !== before.unit &&
        ((await tx.orderItem.count({ where: { productId: id } })) ||
          (await tx.purchaseItem.count({ where: { productId: id } })))
      )
        throw new BadRequestException(
          "Este producto ya tiene encargos o compras; su unidad no se cambia. Crea un producto nuevo con la otra unidad.",
        );
      const after = await tx.product.update({
        where: { id },
        data: body,
        include: { defaultSupplier: true },
      });
      await audit(tx, req.actor.id, "Product", id, "UPDATE", before, after);
      return this.product(after);
    });
  }
  @Get("products/:id/cost-history") history(
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.db.receiptItem.findMany({
      where: { purchaseItem: { productId: id } },
      include: {
        receipt: { include: { purchase: { include: { supplier: true } } } },
        purchaseItem: true,
      },
      orderBy: [
        { receipt: { receivedAt: "asc" } },
        { receipt: { createdAt: "asc" } },
      ],
    });
  }
}
