import { test } from "node:test";
import assert from "node:assert/strict";
import { Store, slots, photoName, logCsv, paddockStats, sortPaddockStats } from "../app/model.js";

const memory = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) };
};

test("slots run newest first and start at the current half-day", () => {
  const morning = slots(new Date(2026, 10, 17, 9, 0), 2).map((s) => s.label);
  assert.deepEqual(morning, ["Nov 17 am", "Nov 16 pm", "Nov 16 am"]);
  const evening = slots(new Date(2026, 10, 17, 15, 0), 1).map((s) => s.label);
  assert.deepEqual(evening, ["Nov 17 pm", "Nov 17 am"]);
  assert.equal(slots(new Date(2026, 10, 1, 15, 0), 2)[2].label, "Oct 31 pm");
});

test("photo names follow 2026_1117_PlusCode and never collide", () => {
  const now = new Date(2026, 10, 17, 9, 0);
  const used = new Set();
  const a = photoName(now, "8R9C+W2", used);
  used.add(a);
  const b = photoName(now, "8R9C+W2", used);
  assert.equal(a, "2026_1117_8R9C+W2.jpg");
  assert.equal(b, "2026_1117_8R9C+W2_2.jpg");
  assert.equal(photoName(new Date(2026, 0, 5), "8R9C+W2", used), "2026_0105_8R9C+W2.jpg");
});

test("known paddocks match regardless of case; new ones are added once", () => {
  const s = new Store(memory());
  assert.equal(s.findPaddock("Haybarn"), null);
  assert.equal(s.addPaddock("  Haybarn  "), "Haybarn");
  assert.equal(s.findPaddock("haybarn"), "Haybarn");
  assert.equal(s.addPaddock("HAYBARN"), "Haybarn");
  assert.deepEqual(s.paddocks, ["Haybarn"]);
});

test("log persists, clears empty rows, and renames carry through", () => {
  const storage = memory();
  const s = new Store(storage);
  s.addPaddock("Haybarn");
  s.addPaddock("River 2");
  s.setSlot("2026-11-17 am", 0, "Haybarn");
  s.setSlot("2026-11-17 am", 1, "River 2");
  s.setSlot("2026-11-16 pm", 0, "Haybarn");

  const again = new Store(storage);
  assert.deepEqual(again.getSlot("2026-11-17 am"), ["Haybarn", "River 2"]);

  again.renamePaddock("Haybarn", "Hay Barn");
  assert.deepEqual(again.getSlot("2026-11-16 pm"), ["Hay Barn", ""]);
  assert.throws(() => again.removePaddock("Hay Barn"), /used in the grazing log/);
  assert.throws(() => again.renamePaddock("River 2", "hay barn"), /already on the list/);

  again.setSlot("2026-11-16 pm", 0, "");
  assert.equal("2026-11-16 pm" in again.data.log, false);

  assert.equal(
    logCsv(again),
    "date,half,paddock_1,paddock_2\r\n2026-11-17,am,Hay Barn,River 2\r\n",
  );
});

test("corrupt storage starts fresh instead of crashing", () => {
  const storage = memory();
  storage.setItem("t_graze", "{not json");
  assert.deepEqual(new Store(storage).paddocks, []);
});

test("paddock stats: days since last graze, visit-to-visit interval, cover", () => {
  const s = new Store(memory());
  for (const p of ["A1", "A2", "B1", "Never"]) s.addPaddock(p);
  // A1: visit Oct 20 pm + Oct 21 am (one visit), then Nov 10 am + pm (one visit)
  s.setSlot("2026-10-20 pm", 0, "A1");
  s.setSlot("2026-10-21 am", 0, "A1");
  s.setSlot("2026-11-10 am", 0, "A1");
  s.setSlot("2026-11-10 pm", 1, "A1");
  // A2: grazed once
  s.setSlot("2026-11-15 am", 0, "A2");
  // B1: three visits, interval uses the last two
  s.setSlot("2026-10-01 am", 0, "B1");
  s.setSlot("2026-10-25 pm", 0, "B1");
  s.setSlot("2026-11-18 am", 1, "B1");
  s.data.covers = { A2: 2450, B1: 3100 };

  const now = new Date(2026, 10, 21, 9, 0);
  const byName = Object.fromEntries(paddockStats(s, now).map((r) => [r.name, r]));
  assert.deepEqual(byName.A1, { name: "A1", lastDays: 11, interval: 21, cover: null });
  assert.deepEqual(byName.A2, { name: "A2", lastDays: 6, interval: null, cover: 2450 });
  assert.deepEqual(byName.B1, { name: "B1", lastDays: 3, interval: 24, cover: 3100 });
  assert.deepEqual(byName.Never, { name: "Never", lastDays: null, interval: null, cover: null });

  const rows = paddockStats(s, now);
  const names = (key, dir) => sortPaddockStats(rows, key, dir).map((r) => r.name);
  assert.deepEqual(names("lastDays", "asc"), ["B1", "A2", "A1", "Never"]);
  assert.deepEqual(names("lastDays", "desc"), ["A1", "A2", "B1", "Never"]);
  assert.deepEqual(names("cover", "desc"), ["B1", "A2", "A1", "Never"]);
  assert.deepEqual(names("interval", "asc"), ["A1", "B1", "A2", "Never"]);
  assert.deepEqual(names("name", "desc"), ["Never", "B1", "A2", "A1"]);
});

test("renaming a paddock keeps its cover", () => {
  const s = new Store(memory());
  s.addPaddock("B05");
  s.data.covers = { B05: 2800 };
  s.renamePaddock("B05", "B05 Top");
  assert.deepEqual(s.data.covers, { "B05 Top": 2800 });
});
