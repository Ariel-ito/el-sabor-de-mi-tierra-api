import { decimal, money } from "./math";

export type CustomerDebt = {
  id: string;
  createdAt: Date;
  balance: string;
};

// FIFO by the date of the encargo/sale, independently of its cycle. An ID
// breaks timestamp ties identically to PostgreSQL's UUID order.
export function allocateCustomerPayment(amount: string, debts: CustomerDebt[]) {
  let remaining = decimal(amount);
  const payments: { orderId: string; amount: string; balanceAfter: string }[] =
    [];
  const ordered = [...debts].sort(
    (a, b) =>
      a.createdAt.getTime() - b.createdAt.getTime() ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  for (const debt of ordered) {
    const balance = decimal(debt.balance);
    if (remaining.lte(0)) break;
    if (balance.lte(0)) continue;
    const applied = remaining.lt(balance) ? remaining : balance;
    payments.push({
      orderId: debt.id,
      amount: money(applied),
      balanceAfter: money(balance.sub(applied)),
    });
    remaining = remaining.sub(applied);
  }
  return {
    payments,
    applied: money(decimal(amount).sub(remaining)),
    excess: money(remaining),
  };
}
