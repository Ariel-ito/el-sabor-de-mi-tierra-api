ALTER TABLE "Product" ADD CONSTRAINT "Product_unit_check" CHECK ("unit" IN ('lb', 'unidad', 'bolsa', 'bote', 'botella', 'paquete', 'docena', 'carton'));
