import { test } from "node:test";
import assert from "node:assert/strict";
import { Store, slots, photoName, logCsv, paddockStats, sortPaddockStats, growthRate, estimateCover, measureCover, COVER_MODEL, growCover, coverRanking, forecastFeed } from "../app/model.js";

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
  for (const p of ["A1", "A2", "B1", "Never", "Measured", "Stale"]) s.addPaddock(p);
  // A1: visit Oct 20 pm + Oct 23 am (3 days apart: one visit), then Nov 10 am + pm (one visit)
  s.setSlot("2026-10-20 pm", 0, "A1");
  s.setSlot("2026-10-23 am", 0, "A1");
  s.setSlot("2026-11-10 am", 0, "A1");
  s.setSlot("2026-11-10 pm", 1, "A1");
  // A2: grazed once, yesterday
  s.setSlot("2026-11-20 pm", 0, "A2");
  // B1: three visits, interval uses the last two; being grazed today, so cover is still the going-in cover
  s.setSlot("2026-10-01 am", 0, "B1");
  s.setSlot("2026-10-25 pm", 0, "B1");
  s.setSlot("2026-11-21 am", 1, "B1");
  // Measured: grazed Nov 1, measured 2650 on Nov 9 -> m12, grown 12 days from 2650
  s.setSlot("2026-11-01 am", 0, "Measured");
  // Stale: measured Oct 5, grazed since (Oct 30) -> back to the estimate
  s.setSlot("2026-10-30 pm", 0, "Stale");
  s.data.covers = { Measured: { value: 2650, date: "2026-11-09" }, Stale: { value: 3400, date: "2026-10-05" } };

  const now = new Date(2026, 10, 21, 9, 0);
  const full = Object.fromEntries(paddockStats(s, now).map((r) => [r.name, r]));
  const byName = Object.fromEntries(Object.entries(full).map(([k, { coverFrom, ...r }]) => [k, r]));
  assert.deepEqual(full.A1.coverFrom, { cover: 1500, date: "2026-11-11" }); // the day after the last grazing
  assert.deepEqual(full.Measured.coverFrom, { cover: 2650, date: "2026-11-09" });
  assert.deepEqual(byName.A1, { name: "A1", lastDays: 11, interval: 21, cover: 2404, coverKind: "e", coverAge: null });
  assert.deepEqual(byName.A2, { name: "A2", lastDays: 1, interval: null, cover: 1500, coverKind: "e", coverAge: null });
  assert.deepEqual(byName.B1, { name: "B1", lastDays: 0, interval: 27, cover: estimateCover(27), coverKind: "e", coverAge: null });
  assert.deepEqual(byName.Never, { name: "Never", lastDays: null, interval: null, cover: null, coverKind: null, coverAge: null });
  assert.deepEqual(byName.Measured, { name: "Measured", lastDays: 20, interval: null, cover: growCover(2650, 12), coverKind: "m", coverAge: 12 });
  assert.deepEqual(byName.Stale, { name: "Stale", lastDays: 22, interval: null, cover: 3179, coverKind: "e", coverAge: null });

  const rows = paddockStats(s, now);
  const names = (key, dir) => sortPaddockStats(rows, key, dir).map((r) => r.name);
  assert.deepEqual(names("lastDays", "asc"), ["B1", "A2", "A1", "Measured", "Stale", "Never"]);
  assert.deepEqual(names("cover", "desc"), ["B1", "Measured", "Stale", "A1", "A2", "Never"]);
  assert.deepEqual(names("interval", "asc"), ["A1", "B1", "A2", "Measured", "Never", "Stale"]);
  assert.deepEqual(names("name", "desc"), ["Stale", "Never", "Measured", "B1", "A2", "A1"]);
});

test("renaming a paddock keeps its measured cover", () => {
  const s = new Store(memory());
  s.addPaddock("B05");
  s.data.covers = { B05: { value: 2800, date: "2026-11-20" } };
  s.renamePaddock("B05", "B05 Top");
  assert.deepEqual(s.data.covers, { "B05 Top": { value: 2800, date: "2026-11-20" } });
});

test("default sort directions: last grazed and cover largest first, interval smallest first", async () => {
  const { SORT_DEFAULTS } = await import("../app/model.js");
  assert.deepEqual(SORT_DEFAULTS, { name: "asc", lastDays: "desc", cover: "desc", interval: "asc" });
});

test("grazing again within 3 days continues the visit; 4 days apart is a new one", () => {
  const s = new Store(memory());
  for (const p of ["Cont", "New"]) s.addPaddock(p);
  for (const k of ["2026-10-20 am", "2026-11-18 pm", "2026-11-21 am"]) s.setSlot(k, 0, "Cont");
  for (const k of ["2026-10-20 am", "2026-11-17 pm", "2026-11-21 am"]) s.setSlot(k, 1, "New");
  const now = new Date(2026, 10, 21, 9, 0);
  const byName = Object.fromEntries(paddockStats(s, now).map((r) => [r.name, r]));
  assert.equal(byName.Cont.interval, 29); // Oct 20 -> Nov 18 (Nov 21 continues it)
  assert.equal(byName.New.interval, 4); // Nov 17 -> Nov 21
  assert.equal(byName.Cont.lastDays, 0);
});

test("growth curve: 100/day at 2000-2200, 5 less per 100 kg either side, minimum 30", () => {
  const rates = [500, 1500, 1900, 2000, 2100, 2200, 2300, 2400, 3600, 4000].map((c) => growthRate(c));
  assert.deepEqual(rates, [30, 75, 95, 100, 100, 100, 95, 90, 30, 30]);
  assert.equal(estimateCover(0), 1500);
  assert.equal(estimateCover(1), 1500);
  assert.equal(estimateCover(2), 1575); // 1500 + 75
  // any [cover, growth] table can replace the curve
  assert.equal(growthRate(250, [[0, 10], [500, 20]]), 15);
});

test("measured cover: grows from the measurement and keeps the figure it replaced", () => {
  const s = new Store(memory());
  for (const p of ["G", "Fresh"]) s.addPaddock(p);
  s.setSlot("2026-11-11 am", 0, "G"); // 10 days before now
  const now = new Date(2026, 10, 21, 9, 0);
  const r = measureCover(s, "G", "2450", now);
  assert.deepEqual(r, {
    paddock: "G", day: "2026-11-21", cover: 2450, predicted: estimateCover(10),
    start_cover: 1500, start_day: "2026-11-12", days_since_grazed: 10, model: COVER_MODEL,
  });
  const later = new Date(2026, 10, 24, 9, 0);
  const g = paddockStats(s, later).find((x) => x.name === "G");
  assert.deepEqual([g.cover, g.coverKind, g.coverAge], [growCover(2450, 3), "m", 3]);
  assert.equal(growCover(2450, 3), 2700); // 87.5/day at 2450, slowing as it grows
  // measuring again: the prediction now grows from the previous measurement
  const again = measureCover(s, "G", 2600, later);
  assert.deepEqual([again.predicted, again.start_cover, again.start_day], [growCover(2450, 3), 2450, "2026-11-21"]);
  assert.equal(measureCover(s, "Fresh", 1800, now).predicted, null); // never grazed: nothing predicted
  assert.throws(() => measureCover(s, "G", "lots", now));
});

test("grazing day keeps the going-in cover; it drops to the residual the next day", () => {
  const s = new Store(memory());
  for (const p of ["P", "Q"]) s.addPaddock(p);
  s.setSlot("2026-11-01 am", 0, "P");
  s.setSlot("2026-11-21 am", 0, "P"); // grazed today
  s.setSlot("2026-11-21 pm", 0, "Q"); // first ever grazing, today
  const today = new Date(2026, 10, 21, 15, 0);
  const tomorrow = new Date(2026, 10, 22, 9, 0);
  const at = (now, name) => paddockStats(s, now).find((x) => x.name === name);
  assert.deepEqual([at(today, "P").cover, at(today, "P").coverKind], [estimateCover(20), "e"]);
  assert.deepEqual([at(tomorrow, "P").cover, at(tomorrow, "P").coverKind], [1500, "e"]);
  assert.equal(at(today, "Q").cover, null); // nothing known before its first grazing
  // measured going in (on the grazing day): shows as m0 that day, and is what the reading predicted against
  const r = measureCover(s, "P", 3000, today);
  assert.equal(r.predicted, estimateCover(20));
  assert.deepEqual([at(today, "P").cover, at(today, "P").coverKind, at(today, "P").coverAge], [3000, "m", 0]);
  assert.deepEqual([at(tomorrow, "P").cover, at(tomorrow, "P").coverKind], [1500, "e"]);
});

test("paddock area: set, clear, follows renames, goes with removal", () => {
  const s = new Store(memory());
  s.addPaddock("A1");
  assert.equal(s.area("A1"), null);
  assert.equal(s.setArea("A1", "3.456"), 3.46);
  assert.equal(s.area("A1"), 3.46);
  s.renamePaddock("A1", "A1 North");
  assert.equal(s.area("A1 North"), 3.46);
  assert.equal(s.area("A1"), null);
  assert.throws(() => s.setArea("A1 North", "-2"));
  assert.throws(() => s.setArea("A1 North", "big"));
  assert.equal(s.setArea("A1 North", ""), null);
  s.setArea("A1 North", 2);
  s.removePaddock("A1 North");
  assert.equal(s.data.info["A1 North"], undefined);
});

test("cover ranking: highest first, available = (cover - 1500) x ha, never below 0", () => {
  const s = new Store(memory());
  for (const p of ["Hi", "Lo", "NoArea", "Never"]) s.addPaddock(p);
  s.setSlot("2026-11-01 am", 0, "Hi"); // 20 days -> estimateCover(20)
  s.setSlot("2026-11-20 am", 0, "Lo"); // 1 day -> 1500 residual
  s.setSlot("2026-11-11 am", 0, "NoArea");
  s.setArea("Hi", 2);
  s.setArea("Lo", 3.5);
  const rows = coverRanking(s, new Date(2026, 10, 21, 9, 0));
  assert.deepEqual(rows.map((r) => r.name), ["Hi", "NoArea", "Lo"]); // "Never" has no cover
  assert.equal(rows[0].available, Math.round((estimateCover(20) - 1500) * 2));
  assert.equal(rows[1].available, null);
  assert.equal(rows[2].available, 0);
  s.data.covers = { Lo: { value: 1200, date: "2026-11-21" } }; // measured below the residual: still 0, not negative
  s.data.log = {};
  assert.equal(coverRanking(s, new Date(2026, 10, 21, 9, 0)).find((r) => r.name === "Lo").available, 0);
});

test("feed forecast: grows, eats the top paddock first, carries part-eaten paddocks over", () => {
  const s = new Store(memory());
  for (const p of ["Big", "Mid", "NoArea"]) s.addPaddock(p);
  const now = new Date(2026, 10, 21, 9, 0);
  s.data.covers = { Big: { value: 3000, date: "2026-11-21" }, Mid: { value: 2500, date: "2026-11-21" }, NoArea: { value: 2000, date: "2026-11-21" } };
  s.setArea("Big", 2);
  s.setArea("Mid", 2);
  const f = forecastFeed(s, now, { cows: 100, perCow: 20, days: 3 }); // 2000 kg a day
  assert.equal(f.demand, 2000);
  assert.deepEqual(f.excluded, ["NoArea"]);
  assert.equal(f.days[0].afc, 2750);
  assert.equal(f.days[0].available, 3000 + 2000);
  // day 1: both grow, then Big is part eaten (it has ~3100+ available)
  const big1 = 3000 + growthRate(3000);
  const mid1 = 2500 + growthRate(2500);
  assert.deepEqual(f.days[1].grazed, [{ name: "Big", finished: false }]);
  assert.equal(f.days[1].available, Math.round((big1 - 1500) * 2 - 2000 + (mid1 - 1500) * 2));
  // day 2: Big (not growing while open) is finished, then Mid is started
  assert.deepEqual(f.days[2].grazed.map((g) => [g.name, g.finished]), [["Big", true], ["Mid", false]]);
  assert.equal(f.days[0].date, "2026-11-21");
  assert.equal(f.days[3].date, "2026-11-24");
});

test("feed forecast: reports a shortfall when nothing is left above the residual", () => {
  const s = new Store(memory());
  s.addPaddock("Only");
  s.setArea("Only", 1);
  s.data.covers = { Only: { value: 1600, date: "2026-11-21" } };
  const f = forecastFeed(s, new Date(2026, 10, 21, 9, 0), { cows: 10, perCow: 20, days: 2 });
  assert.equal(f.days[1].grazed[0].finished, true);
  assert.ok(f.days[1].shortfall > 0);
  assert.equal(f.days[2].shortfall, 200); // eaten out yesterday: sits at 1500, nothing to eat
});
