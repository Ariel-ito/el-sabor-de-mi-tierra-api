import { Prisma } from "@prisma/client";
import { decimal, money } from "./math";
// Ownership is fixed at 50/50; contributions add value, never shares.
export const OWNERS = [
  { key: "ARIEL", name: "Ariel Martínez", share: 0.5 },
  { key: "MARIA", name: "María Borjas", share: 0.5 },
] as const;
export type OwnerKey = (typeof OWNERS)[number]["key"];
const HN_OFFSET = "-06:00";
// [start, end) of a calendar month in Honduras time.
export function monthRange(month: string) {
  const [y, m] = month.split("-").map(Number);
  const next =
    m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  return {
    start: new Date(`${month}-01T00:00:00${HN_OFFSET}`),
    end: new Date(`${next}-01T00:00:00${HN_OFFSET}`),
  };
}
const day = (y: number, m: number, d: number) =>
  new Date(
    `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}T00:00:00${HN_OFFSET}`,
  );
const hnDate = (d: Date) => new Date(d.getTime() - 6 * 3600000);
// Due dates of a recurring expense from its start up to `until`, each with a
// stable key so a period is generated once.
export function recurringPeriods(
  template: { frequency: string; day: number; startsOn: Date },
  until: Date,
) {
  const out: { periodKey: string; date: Date }[] = [];
  const start = hnDate(template.startsOn);
  if (template.frequency === "MONTHLY") {
    let y = start.getUTCFullYear(),
      m = start.getUTCMonth() + 1;
    for (;;) {
      const due = day(y, m, template.day);
      if (due > until) break;
      if (
        due >=
        day(start.getUTCFullYear(), start.getUTCMonth() + 1, start.getUTCDate())
      )
        out.push({
          periodKey: `${y}-${String(m).padStart(2, "0")}`,
          date: due,
        });
      m === 12 ? ((y += 1), (m = 1)) : (m += 1);
    }
    return out;
  }
  const step = template.frequency === "BIWEEKLY" ? 14 : 7;
  let due = day(
    start.getUTCFullYear(),
    start.getUTCMonth() + 1,
    start.getUTCDate(),
  );
  while (hnDate(due).getUTCDay() !== template.day)
    due = new Date(due.getTime() + 86400000);
  while (due <= until) {
    out.push({ periodKey: hnDate(due).toISOString().slice(0, 10), date: due });
    due = new Date(due.getTime() + step * 86400000);
  }
  return out;
}
// One line of the ledger, whether typed in or derived from sales and purchases.
export type Entry = {
  kind: "INCOME" | "EXPENSE";
  status: string;
  amount: Prisma.Decimal.Value;
  systemKey: string | null;
  inResult: boolean;
  categoryName: string;
  paidBy: string;
  personalMode: string | null;
  reimbursedAt: Date | null;
  owner: string | null;
  recurring: boolean;
};
const zero = () => decimal(0);
// Cycles in the order an expense spreads over them.
export const oldestFirst = (rounds: { id: string; opensAt: Date }[]) =>
  [...rounds]
    .sort(
      (a, b) =>
        a.opensAt.getTime() - b.opensAt.getTime() || a.id.localeCompare(b.id),
    )
    .map((r) => r.id);
// Each cycle's part of the expenses assigned to cycles. One bought for
// several cycles is split evenly, in cents, over its cycle and the next ones
// (cycles oldest first); parts for cycles not created yet wait for them.
export function cycleShares<
  T extends {
    roundId: string | null;
    spreadCycles: number;
    amount: Prisma.Decimal.Value;
  },
>(cycles: string[], expenses: T[]) {
  const shares = new Map<
    string,
    { expense: T; amount: Prisma.Decimal; part: number; of: number }[]
  >();
  for (const expense of expenses) {
    const at = expense.roundId ? cycles.indexOf(expense.roundId) : -1;
    if (at < 0) continue;
    const of = Math.max(1, expense.spreadCycles);
    const cents = decimal(expense.amount).mul(100).round().toNumber();
    const base = Math.floor(cents / of);
    for (let k = 0; k < of && at + k < cycles.length; k++) {
      const list = shares.get(cycles[at + k]) ?? [];
      list.push({
        expense,
        amount: decimal(base + (k < cents - base * of ? 1 : 0)).div(100),
        part: k + 1,
        of,
      });
      shares.set(cycles[at + k], list);
    }
  }
  return shares;
}
const perOwner = () =>
  Object.fromEntries(OWNERS.map((o) => [o.key, zero()])) as Record<
    OwnerKey,
    Prisma.Decimal
  >;
export function summarize(entries: Entry[]) {
  let income = zero(),
    expense = zero(),
    cash = zero(),
    distributed = zero(),
    pendingRecurring = zero();
  const contributed = perOwner(),
    owedToOwner = perOwner();
  const byCategory = new Map<
    string,
    { kind: string; amount: Prisma.Decimal; recurring: Prisma.Decimal }
  >();
  for (const e of entries) {
    const amount = decimal(e.amount);
    if (e.status === "SKIPPED") continue;
    if (e.status === "PENDING") {
      pendingRecurring = pendingRecurring.add(amount);
      continue;
    }
    const owner = (
      e.paidBy !== "BUSINESS" ? e.paidBy : e.owner
    ) as OwnerKey | null;
    if (e.inResult) {
      if (e.kind === "INCOME") income = income.add(amount);
      else expense = expense.add(amount);
      const row = byCategory.get(e.categoryName) ?? {
        kind: e.kind,
        amount: zero(),
        recurring: zero(),
      };
      row.amount = row.amount.add(amount);
      if (e.recurring) row.recurring = row.recurring.add(amount);
      byCategory.set(e.categoryName, row);
    }
    if (e.systemKey === "PROFIT_DISTRIBUTION")
      distributed = distributed.add(amount);
    if (e.systemKey === "OWNER_CONTRIBUTION" && owner)
      contributed[owner] = contributed[owner].add(amount);
    // Money the business itself received or paid out.
    if (e.kind === "INCOME") cash = cash.add(amount);
    else if (e.paidBy === "BUSINESS") cash = cash.sub(amount);
    else if (owner && e.personalMode === "CONTRIBUTE")
      contributed[owner] = contributed[owner].add(amount);
    else if (owner && e.personalMode === "REIMBURSE") {
      if (e.reimbursedAt) cash = cash.sub(amount);
      else owedToOwner[owner] = owedToOwner[owner].add(amount);
    }
  }
  const view = (r: Record<OwnerKey, Prisma.Decimal>) =>
    Object.fromEntries(
      Object.entries(r).map(([k, v]) => [k, money(v)]),
    ) as Record<OwnerKey, string>;
  const sum = (r: Record<OwnerKey, Prisma.Decimal>) =>
    money(Object.values(r).reduce((a, v) => a.add(v), zero()));
  return {
    income: money(income),
    expense: money(expense),
    result: money(income.sub(expense)),
    distributed: money(distributed),
    available: money(income.sub(expense).sub(distributed)),
    contributed: view(contributed),
    contributedTotal: sum(contributed),
    owedToOwners: view(owedToOwner),
    owedToOwnersTotal: sum(owedToOwner),
    pendingRecurring: money(pendingRecurring),
    cashExpected: money(cash),
    byCategory: [...byCategory.entries()]
      .map(([name, r]) => ({
        name,
        kind: r.kind,
        amount: money(r.amount),
        recurring: money(r.recurring),
      }))
      .sort((a, b) => Number(b.amount) - Number(a.amount)),
  };
}

// Expenses belong to the day they happened; cash reimbursements belong to the
// day the business paid its owner back. Read the complete ledger for a period
// so a reimbursement of a prior month's expense cannot disappear.
export function summarizePeriod(
  entries: (Entry & { date: Date })[],
  range: { start: Date; end: Date },
) {
  const inPeriod = (date: Date) => date >= range.start && date < range.end;
  const selected = entries.filter((e) => inPeriod(e.date));
  const result = summarize(
    selected.map((e) => ({
      ...e,
      reimbursedAt:
        e.reimbursedAt && e.reimbursedAt < range.end ? e.reimbursedAt : null,
    })),
  );
  // Original personal expenses never take cash from the business themselves.
  const originalCash = summarize(
    selected.map((e) => ({ ...e, reimbursedAt: null })),
  ).cashExpected;
  const repaid = entries
    .filter(
      (e) =>
        e.status === "PAID" &&
        e.kind === "EXPENSE" &&
        e.paidBy !== "BUSINESS" &&
        e.personalMode === "REIMBURSE" &&
        e.reimbursedAt &&
        inPeriod(e.reimbursedAt),
    )
    .reduce((sum, e) => sum.add(e.amount), decimal(0));
  return { ...result, cashExpected: money(decimal(originalCash).sub(repaid)) };
}
