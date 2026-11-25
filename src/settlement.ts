import { BadRequestException } from "@nestjs/common";
import { decimal, money } from "./math";

export type ExcessDisposition = "TIP" | "CREDIT" | "CHANGE";
export function settlePayment(
  received: string,
  balance: string,
  disposition?: ExcessDisposition,
  legacyCredit = false,
) {
  const amount = decimal(received),
    due = decimal(balance);
  if (amount.lte(0) || due.lte(0))
    throw new BadRequestException(
      "El pago y el saldo pendiente deben ser mayores a cero.",
    );
  if (legacyCredit && disposition && disposition !== "CREDIT")
    throw new BadRequestException("El destino del sobrante es contradictorio.");
  const applied = amount.lt(due) ? amount : due;
  const excess = amount.sub(applied);
  const choice = disposition ?? (legacyCredit ? "CREDIT" : undefined);
  if (excess.gt(0) && !choice)
    throw new BadRequestException(
      "Elige si el sobrante es propina, saldo a favor o cambio devuelto.",
    );
  return {
    receivedAmount: money(amount),
    amount: money(applied),
    tipAmount: money(choice === "TIP" ? excess : 0),
    changeAmount: money(choice === "CHANGE" ? excess : 0),
    creditAmount: money(choice === "CREDIT" ? excess : 0),
    excessDisposition: excess.gt(0) ? choice! : null,
  };
}
