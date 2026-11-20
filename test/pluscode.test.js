import { test } from "node:test";
import assert from "node:assert/strict";
import { encode, decode, shortCode } from "../app/pluscode.js";

test("known codes", () => {
  assert.equal(encode(47.0000625, 8.0000625), "8FVC2222+22");
  assert.equal(encode(1.286785, 103.854503), "6PH57VP3+PR");
});

test("short code drops the first four digits", () => {
  assert.equal(shortCode("4RJX8R9C+W2"), "8R9C+W2");
});

// Tolerance: like the reference library, coordinates are first rounded to a ~4 mm / ~1.4 cm grid.
test("every encoded point sits inside its decoded cell", () => {
  for (let i = 0; i < 2000; i++) {
    const lat = Math.random() * 179.98 - 89.99;
    const lng = Math.random() * 359.98 - 179.99;
    const cell = decode(encode(lat, lng));
    assert.ok(lat >= cell.south - 1e-7 && lat < cell.south + cell.size + 1e-7, `lat ${lat}`);
    assert.ok(lng >= cell.west - 2e-7 && lng < cell.west + cell.size + 2e-7, `lng ${lng}`);
  }
});

test("edges: poles and the date line", () => {
  assert.match(encode(90, 0), /^C[0-9A-Z]{7}\+[0-9A-Z]{2}$/);
  assert.equal(encode(0, 180), encode(0, -180));
  assert.throws(() => encode(NaN, 0));
});
