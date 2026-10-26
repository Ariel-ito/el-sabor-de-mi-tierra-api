import { Prisma } from "@prisma/client";
import { decimal } from "./math";
// What a product needed beyond its encargos in a cycle: sold apart, late
// encargos served from stock, and what was lost, given away or eaten.
export type ExtraUse = {
  roundId: string;
  productId: string;
  kind: "sold" | "stock" | "loss" | "sample" | "personal";
  quantity: Prisma.Decimal.Value;
};
const KINDS = ["sold", "stock", "loss", "sample", "personal"] as const;
// Fewer earlier cycles than this say too little to suggest anything.
export const MIN_CYCLES = 2;
// How much to buy on top of the encargos: the average extra the last cycles
// used, rounded up to what can be bought (half pounds, whole units).
export function extraSuggestions(
  cycleIds: string[],
  uses: ExtraUse[],
  products: { id: string; name: string; unit: string }[],
) {
  if (cycleIds.length < MIN_CYCLES) return [];
  return products
    .map((p) => {
      const history = cycleIds.map((roundId) => {
        const own = uses.filter(
          (u) => u.roundId === roundId && u.productId === p.id,
        );
        const by = Object.fromEntries(
          KINDS.map((k) => [
            k,
            own
              .filter((u) => u.kind === k)
              .reduce((a, u) => a.add(u.quantity), decimal(0)),
          ]),
        ) as Record<(typeof KINDS)[number], Prisma.Decimal>;
        const total = KINDS.reduce((a, k) => a.add(by[k]), decimal(0));
        return { roundId, by, total };
      });
      const average = history
        .reduce((a, h) => a.add(h.total), decimal(0))
        .div(cycleIds.length);
      const step = p.unit === "lb" ? 0.5 : 1;
      const suggested = Math.ceil(average.toNumber() / step - 1e-9) * step;
      return {
        productId: p.id,
        name: p.name,
        unit: p.unit,
        average: average.toDecimalPlaces(2).toString(),
        suggested: String(suggested),
        history: history.map((h) => ({
          roundId: h.roundId,
          ...Object.fromEntries(KINDS.map((k) => [k, h.by[k].toString()])),
          total: h.total.toString(),
        })),
      };
    })
    .filter((r) => Number(r.suggested) > 0)
    .sort((a, b) => Number(b.average) - Number(a.average));
}
