ALTER TABLE "Product" DROP CONSTRAINT "Product_unit_check";
ALTER TABLE "Product" ADD CONSTRAINT "Product_unit_check"
  CHECK ("unit" IN ('lb', 'unidad', 'bolsa', 'bote', 'frasco', 'botella', 'paquete', 'docena', 'carton'));
