import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { ItemDto, ProductPatchDto } from "../src/dto";
import { expiry } from "../src/inventory";
import { coordinatesIn, isMapsHost } from "../src/geo";
import {
  decimal,
  lineTotal,
  purchaseSummary,
  serializeOrder,
} from "../src/math";
import {
  hashPassword,
  hashToken,
  newToken,
  verifyPassword,
} from "../src/security";
test("half pounds use exact decimals and round each line half-up", () => {
  assert.equal(lineTotal("0.5", "53.01"), "26.51");
  const result = serializeOrder({
    items: [
      { quantity: decimal("0.5"), unitPrice: decimal("53.01") },
      { quantity: decimal("0.5"), unitPrice: decimal("53.01") },
    ],
  });
  assert.equal(result.total, "53.02");
});
test("purchase summary aggregates duplicates and preserves alternate suppliers", () => {
  const item = (supplierId: string, q: string) => ({
    productId: "p",
    supplierId,
    quantity: decimal(q),
    supplier: { name: supplierId, region: "Olancho" },
    product: { name: "Crema", estimatedCost: decimal("53.01") },
  });
  const result = purchaseSummary("r", [
    { items: [item("a", "0.5"), item("a", "1"), item("b", "0.5")] },
  ]);
  assert.equal(result.totalQuantity, "2");
  assert.equal(result.groups.length, 2);
  assert.equal(result.groups[0].items[0].quantity, "1.5");
  assert.equal(result.estimatedTotal, "106.03");
});
test("only positive half-pound quantities and bounded prices accepted", async () => {
  for (const quantity of ["0.5", "0.50", "1", "1.5", "1.500"]) {
    const input = plainToInstance(ItemDto, {
      productId: "f0f918bc-cc44-47e2-a5c9-e50a6898be73",
      supplierId: "f0f918bc-cc44-47e2-a5c9-e50a6898be73",
      quantity,
      unitPrice: "53.01",
    });
    assert.equal((await validate(input)).length, 0);
  }
  for (const quantity of ["0", "-1", "0.25", "1e2", "1000000"]) {
    assert.ok(
      (await validate(plainToInstance(ItemDto, { quantity }))).length > 0,
    );
  }
  assert.ok(
    (await validate(plainToInstance(ProductPatchDto, { salePrice: null })))
      .length > 0,
  );
});
test("passwords salted; tokens opaque and only hashes persist", async () => {
  const password = "long-testing-password";
  const first = await hashPassword(password),
    second = await hashPassword(password);
  assert.notEqual(first, second);
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword("wrong", first), false);
  const token = newToken();
  assert.equal(token.length, 43);
  assert.equal(hashToken(token).length, 64);
  assert.notEqual(token, hashToken(token));
});
test("expiry counts Honduras calendar days and warns inside the window", () => {
  const now = new Date("2026-10-07T05:00:00Z"); // 6 Oct, 11 p.m. in Honduras
  const p = { shelfLifeDays: 5, warnDays: 2 };
  assert.equal(expiry(null, p, now).expiryStatus, null);
  assert.deepEqual(
    [
      expiry(new Date("2026-10-09T18:00:00Z"), p, now),
      expiry(new Date("2026-10-08T18:00:00Z"), p, now),
      expiry(new Date("2026-10-06T18:00:00Z"), p, now),
      expiry(new Date("2026-10-05T18:00:00Z"), p, now),
    ].map((e) => [e.daysLeft, e.expiryStatus]),
    [
      [3, "OK"],
      [2, "SOON"],
      [0, "SOON"],
      [-1, "EXPIRED"],
    ],
  );
});
test("map links and pasted coordinates give a spot", () => {
  const spot = { latitude: 14.0723, longitude: -87.1921 };
  for (const text of [
    "https://maps.google.com/?q=14.0723,-87.1921",
    "https://www.google.com/maps/place/Tegucigalpa/@14.0723,-87.1921,15z/data=!4m6",
    "https://www.google.com/maps/place/X/data=!3d14.0723!4d-87.1921",
    "https://www.google.com/maps/search/14.0723,-87.1921?entry=tts",
    "https://www.google.com/maps/dir/?api=1&destination=14.0723%2C-87.1921",
    " 14.0723, -87.1921 ",
  ])
    assert.deepEqual(coordinatesIn(text), spot, text);
  assert.equal(coordinatesIn("https://maps.app.goo.gl/abc123"), null);
  assert.equal(coordinatesIn("95.1, 10.2"), null);
  assert.ok(isMapsHost(new URL("https://maps.app.goo.gl/abc")));
  assert.ok(!isMapsHost(new URL("https://evil.example/maps")));
  assert.ok(!isMapsHost(new URL("http://maps.app.goo.gl/abc")));
});
