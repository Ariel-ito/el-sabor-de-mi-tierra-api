import {
  Delete,
  NotFoundException,
  ConflictException,
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
import {
  CustomerDto,
  ProductCategoryDto,
  ProductDto,
  ProductPatchDto,
  SupplierDto,
} from "./dto";
import { syncComboCosts } from "./assemblies.controller";
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
  @Get("product-categories") async categories() {
    const rows = await this.db.productCategory.findMany({
      include: { _count: { select: { products: true } } },
      orderBy: { name: "asc" },
    });
    return rows.map(({ _count, ...c }) => ({
      ...c,
      productCount: _count.products,
    }));
  }
  @Post("product-categories") async createCategory(
    @Body() body: ProductCategoryDto,
    @Req() req: AuthRequest,
  ) {
    return this.db.$transaction(async (tx) => {
      const name = body.name.trim();
      if (
        await tx.productCategory.findFirst({
          where: { name: { equals: name, mode: "insensitive" } },
        })
      )
        throw new ConflictException("Ya existe una categoría con ese nombre.");
      const created = await tx.productCategory.create({ data: { name } });
      await audit(
        tx,
        req.actor.id,
        "ProductCategory",
        created.id,
        "CREATE",
        null,
        created,
      );
      return created;
    });
  }
  @Patch("product-categories/:id") async renameCategory(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: ProductCategoryDto,
    @Req() req: AuthRequest,
  ) {
    return this.db.$transaction(async (tx) => {
      const before = await tx.productCategory.findUnique({ where: { id } });
      if (!before) throw new NotFoundException("Categoría no encontrada.");
      const name = body.name.trim();
      if (
        await tx.productCategory.findFirst({
          where: {
            id: { not: id },
            name: { equals: name, mode: "insensitive" },
          },
        })
      )
        throw new ConflictException("Ya existe una categoría con ese nombre.");
      const after = await tx.productCategory.update({
        where: { id },
        data: { name },
      });
      await audit(
        tx,
        req.actor.id,
        "ProductCategory",
        id,
        "UPDATE",
        before,
        after,
      );
      return after;
    });
  }
  // Only empty categories go away; move their products first.
  @Delete("product-categories/:id") async deleteCategory(
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: AuthRequest,
  ) {
    return this.db.$transaction(async (tx) => {
      const before = await tx.productCategory.findUnique({
        where: { id },
        include: { _count: { select: { products: true } } },
      });
      if (!before) throw new NotFoundException("Categoría no encontrada.");
      if (before._count.products)
        throw new ConflictException(
          "La categoría tiene productos; cámbialos de categoría antes de borrarla.",
        );
      await tx.productCategory.delete({ where: { id } });
      await audit(tx, req.actor.id, "ProductCategory", id, "DELETE", before, {
        deleted: true,
      });
      return { ok: true };
    });
  }
  @Get("products") async products() {
    return (
      await this.db.product.findMany({
        include: {
          defaultSupplier: true,
          category: true,
          components: { include: { component: true } },
        },
        orderBy: { name: "asc" },
      })
    ).map((p) => this.product(p));
  }
  private async checkCategory(categoryId?: string | null) {
    if (
      categoryId &&
      !(await this.db.productCategory.findUnique({ where: { id: categoryId } }))
    )
      throw new BadRequestException("Categoría inexistente.");
  }
  @Post("products") async createProduct(@Body() body: ProductDto) {
    await this.checkCategory(body.categoryId);
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
    await this.checkCategory(body.categoryId);
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
      await tx.product.update({ where: { id }, data: body });
      // A combo's cost comes from its recipe; a component's cost feeds the
      // combos that use it.
      await syncComboCosts(tx, [id]);
      const usedIn = await tx.productComponent.findMany({
        where: { componentId: id },
      });
      await syncComboCosts(
        tx,
        usedIn.map((c) => c.comboId),
      );
      const after = await tx.product.findUniqueOrThrow({
        where: { id },
        include: {
          defaultSupplier: true,
          category: true,
          components: { include: { component: true } },
        },
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
