ALTER TABLE "Product" ADD CONSTRAINT "Product_nonnegative_prices" CHECK ("salePrice" >= 0 AND "estimatedCost" >= 0);
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_positive_half_pounds" CHECK ("quantity" > 0 AND MOD("quantity", 0.5) = 0);
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_nonnegative_price" CHECK ("unitPrice" >= 0);
ALTER TABLE "Order" ADD CONSTRAINT "Order_positive_version" CHECK ("version" > 0);
ALTER TABLE "Round" ADD CONSTRAINT "Round_valid_window" CHECK ("closesAt" > "opensAt");
