import { test } from "node:test";
import assert from "node:assert/strict";
import { Store, slots, photoName, logCsv } from "../app/model.js";

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
