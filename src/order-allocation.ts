// Keep customers in FIFO order, but allocate an order's explicit stock lines
// before its preorders. A split product must not let its preorder consume the
// stock that the same order has explicitly selected from existing inventory.
export function stockFirstWithinOrders<
  T extends { orderId: string; source: string },
>(items: T[]): T[] {
  const orders = new Map<string, T[]>();
  for (const item of items) {
    const group = orders.get(item.orderId) ?? [];
    group.push(item);
    orders.set(item.orderId, group);
  }
  return [...orders.values()].flatMap((items) => [
    ...items.filter((i) => i.source === "STOCK"),
    ...items.filter((i) => i.source !== "STOCK"),
  ]);
}
