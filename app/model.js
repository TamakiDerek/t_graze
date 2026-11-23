// App data and the rules around it. No DOM here, so it runs under `node --test`.
// Everything lives in one JSON document in localStorage (small: ~730 log rows a year).

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n) => String(n).padStart(2, "0");

/** "2026-11-17" for a local date. */
export function isoDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "Nov 17 am" */
export function slotLabel(date, half) {
  return `${MONTHS[date.getMonth()]} ${date.getDate()} ${half}`;
}

export function currentHalf(now) {
  return now.getHours() < 12 ? "am" : "pm";
}

/**
 * Half-day slots, newest first, starting at the current half-day and going back `days` days.
 * @returns {{key:string, date:string, half:"am"|"pm", label:string}[]}
 */
export function slots(now, days) {
  const out = [];
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  for (let i = 0; i < days; i++) {
    const halves = i === 0 && currentHalf(now) === "am" ? ["am"] : ["pm", "am"];
    for (const half of halves) {
      const date = isoDate(day);
      out.push({ key: `${date} ${half}`, date, half, label: slotLabel(day, half) });
    }
    day.setDate(day.getDate() - 1);
  }
  return out;
}

/** Photo file name: 2026_1117_8R9C+W2.jpg, with _2, _3 ... if that name was already used. */
export function photoName(now, shortPlusCode, usedNames) {
  const base = `${now.getFullYear()}_${pad(now.getMonth() + 1)}${pad(now.getDate())}_${shortPlusCode}`;
  let name = `${base}.jpg`;
  for (let n = 2; usedNames.has(name); n++) name = `${base}_${n}.jpg`;
  return name;
}

// info: per-paddock details, { name: { area: hectares } }
const EMPTY = () => ({ version: 1, paddocks: [], log: {}, photos: [], covers: {}, info: {} });

const DAY_MS = 86_400_000;
const dayNumber = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
};
const dayIso = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);

// Cover estimate until real measurements exist: 1500 kg DM/ha the day after grazing, then each day
// it grows by GROWTH_CURVE's rate for the cover it has reached. A measured cover restarts it: from the
// measurement day it grows the same way from the measured value, until the paddock is next grazed.
export const COVER_AFTER_GRAZING = 1500;

// Daily growth (kg DM/ha/day) by current cover (kg DM/ha): [cover, growth] points, straight lines
// between them, flat beyond the ends. Replace with a finer table as trials refine it.
// Now: 100/day from 2000 to 2200, 5 less per 100 kg either side, never below 30.
export const GROWTH_CURVE = [
  [600, 30],
  [2000, 100],
  [2200, 100],
  [3600, 30],
];

// Saved with every measured cover, so readings can be matched to the estimate that predicted them.
// Change it whenever GROWTH_CURVE or the estimate rule changes.
export const COVER_MODEL = "curve-2026-11-23-m"; // -m: measured covers grow too

/** Growth per day at a given cover, interpolated from a [cover, growth] table sorted by cover. */
export function growthRate(cover, curve = GROWTH_CURVE) {
  if (cover <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    const [c1, g1] = curve[i];
    if (cover <= c1) {
      const [c0, g0] = curve[i - 1];
      return g0 + ((g1 - g0) * (cover - c0)) / (c1 - c0);
    }
  }
  return curve[curve.length - 1][1];
}

/** Cover after growing for a number of days from a starting cover, a day at a time. */
export function growCover(startCover, days, curve = GROWTH_CURVE) {
  let cover = startCover;
  for (let d = 0; d < days; d++) cover += growthRate(cover, curve);
  return Math.round(cover);
}

/** Estimated cover N days after grazing (day 0 and day 1 = the residual). */
export function estimateCover(daysSinceGrazed, curve = GROWTH_CURVE) {
  return growCover(COVER_AFTER_GRAZING, Math.max(0, daysSinceGrazed - 1), curve);
}
// Entries up to this many days apart count as one continuing grazing, not a new one.
export const GRAZING_GAP_DAYS = 3;

/**
 * Per-paddock figures for the Paddocks table.
 * A paddock grazed again within GRAZING_GAP_DAYS of its previous entry is still the same visit
 * (a continuation), so e.g. Nov 21 pm + Nov 24 am is one visit starting Nov 21.
 * - lastDays: days from the latest entry to today (0 = today)
 * - interval: days between the start of the previous visit and the start of the latest one
 * - cover / coverKind / coverAge / coverFrom:
 *     "m" = measured on a day after the last grazing, grown since; coverAge = days since measured
 *     "e" = estimated from the residual after grazing
 *     On a day the paddock is being grazed, cover is still what it was going in (today's entry is
 *     ignored for cover), so "how much grass are they getting?" has an answer. It drops to the
 *     residual the next day. A cover measured that day counts as the pre-grazing cover.
 *     null = never grazed and never measured
 *     coverFrom = { cover, date } the figure grew from (the measurement, or the residual the day after grazing)
 */
export function paddockStats(store, now) {
  const today = dayNumber(isoDate(now));
  const days = new Map(); // paddock -> unique day numbers it appears on
  for (const [key, row] of Object.entries(store.data.log)) {
    const n = dayNumber(key.split(" ")[0]);
    for (const p of row) {
      if (!p) continue;
      if (!days.has(p)) days.set(p, new Set());
      days.get(p).add(n);
    }
  }
  return store.paddocks.map((name) => {
    const list = [...(days.get(name) ?? [])].sort((a, b) => a - b);
    const visitStarts = list.filter((d, i) => i === 0 || d - list[i - 1] > GRAZING_GAP_DAYS);
    const lastGrazed = list.length ? list[list.length - 1] : null;
    const lastDays = lastGrazed == null ? null : today - lastGrazed;

    // Cover ignores today's grazing: it resets to the residual from tomorrow.
    const coverGrazed = list.filter((d) => d < today).at(-1) ?? null;
    let start = null; // where today's cover grows from
    let coverKind = null;
    const measured = store.data.covers?.[name];
    const measuredDay = measured?.date ? dayNumber(measured.date) : null;
    if (Number.isFinite(measured?.value) && measuredDay != null && (coverGrazed == null || measuredDay > coverGrazed)) {
      start = { cover: measured.value, day: measuredDay };
      coverKind = "m";
    } else if (coverGrazed != null) {
      start = { cover: COVER_AFTER_GRAZING, day: coverGrazed + 1 };
      coverKind = "e";
    }
    const cover = start ? growCover(start.cover, Math.max(0, today - start.day)) : null;
    const coverAge = coverKind === "m" ? Math.max(0, today - start.day) : null;

    return {
      name,
      lastDays,
      interval: visitStarts.length > 1 ? visitStarts.at(-1) - visitStarts.at(-2) : null,
      cover,
      coverKind,
      coverAge,
      coverFrom: start ? { cover: start.cover, date: dayIso(start.day) } : null,
    };
  });
}

/**
 * Record a measured cover for a paddock today. It shows as "m<days>", growing, until the paddock is next grazed.
 * Returns the reading to upload: the measurement plus what the app was showing for the same day and
 * where that figure grew from, so the growth model can later be checked and refitted against real data.
 */
export function measureCover(store, name, value, now) {
  const cover = Math.round(Number(value));
  if (!Number.isFinite(cover) || cover < 0 || cover > 10000) throw new Error("Cover must be a number from 0 to 10000");
  const stat = paddockStats(store, now).find((r) => r.name === name);
  const grazed = stat?.lastDays != null;
  const day = isoDate(now);
  store.data.covers ??= {};
  store.data.covers[name] = { value: cover, date: day };
  store.save();
  return {
    paddock: name,
    day,
    cover,
    predicted: stat?.cover ?? null,
    start_cover: stat?.coverFrom?.cover ?? null,
    start_day: stat?.coverFrom?.date ?? null,
    days_since_grazed: grazed ? stat.lastDays : null,
    model: COVER_MODEL,
  };
}

// Paddocks are grazed down to this; above it is feed the cows can eat.
export const GRAZE_TO = COVER_AFTER_GRAZING;

/**
 * Paddocks with a known cover, highest cover first, with the feed available in each:
 * available = (cover - GRAZE_TO) x hectares in kg DM, never below 0; null when the area isn't known.
 */
export function coverRanking(store, now) {
  return paddockStats(store, now)
    .filter((r) => r.cover != null)
    .map((r) => {
      const area = store.area(r.name);
      const available = area == null ? null : Math.max(0, Math.round((r.cover - GRAZE_TO) * area));
      return { name: r.name, cover: r.cover, coverKind: r.coverKind, coverAge: r.coverAge, area, available };
    })
    .sort((a, b) => b.cover - a.cover || a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** Default direction when a column is first tapped: longest since grazed first, cover largest first, interval shortest first. */
export const SORT_DEFAULTS = { name: "asc", lastDays: "desc", cover: "desc", interval: "asc" };

/** Sorts paddockStats rows; rows with no value go last whichever way round. */
export function sortPaddockStats(rows, key, dir) {
  const sign = dir === "desc" ? -1 : 1;
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  return [...rows].sort((a, b) => {
    if (key === "name") return sign * byName(a, b);
    const x = a[key];
    const y = b[key];
    if (x == null || y == null) return x == null && y == null ? byName(a, b) : x == null ? 1 : -1;
    return sign * (x - y) || byName(a, b);
  });
}

export class Store {
  /** @param {Storage} storage localStorage, or any object with getItem/setItem */
  constructor(storage, key = "t_graze") {
    this.storage = storage;
    this.key = key;
    try {
      this.data = { ...EMPTY(), ...JSON.parse(storage.getItem(key) || "{}") };
    } catch {
      this.data = EMPTY();
    }
  }

  save() {
    this.storage.setItem(this.key, JSON.stringify(this.data));
  }

  get paddocks() {
    return [...this.data.paddocks].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
  }

  /** The paddock's name as stored, matching case and surrounding spaces loosely; null if unknown. */
  findPaddock(name) {
    const want = name.trim().toLowerCase();
    return this.data.paddocks.find((p) => p.toLowerCase() === want) ?? null;
  }

  addPaddock(name) {
    const clean = name.trim().replace(/\s+/g, " ");
    if (!clean) throw new Error("empty paddock name");
    const existing = this.findPaddock(clean);
    if (existing) return existing;
    this.data.paddocks.push(clean);
    this.save();
    return clean;
  }

  /** Renames a paddock everywhere it appears in the log. */
  renamePaddock(oldName, newName) {
    const clean = newName.trim().replace(/\s+/g, " ");
    if (!clean) throw new Error("empty paddock name");
    const clash = this.findPaddock(clean);
    if (clash && clash !== oldName) throw new Error(`"${clash}" is already on the list`);
    this.data.paddocks = this.data.paddocks.map((p) => (p === oldName ? clean : p));
    for (const map of [this.data.covers, this.data.info]) { // keyed by paddock name
      if (map && oldName in map) {
        map[clean] = map[oldName];
        if (clean !== oldName) delete map[oldName];
      }
    }
    for (const row of Object.values(this.data.log)) {
      row.forEach((p, i) => {
        if (p === oldName) row[i] = clean;
      });
    }
    this.save();
    return clean;
  }

  /** How many log rows use the paddock (the app won't delete one that's in use). */
  paddockUses(name) {
    return Object.values(this.data.log).filter((row) => row.includes(name)).length;
  }

  removePaddock(name) {
    if (this.paddockUses(name)) throw new Error(`"${name}" is used in the grazing log`);
    this.data.paddocks = this.data.paddocks.filter((p) => p !== name);
    delete this.data.info?.[name];
    this.save();
  }

  /** Paddock size in hectares, or null if not known. */
  area(name) {
    return this.data.info?.[name]?.area ?? null;
  }

  /** Sets (or clears, with "" / null) a paddock's size in hectares. Returns the stored value. */
  setArea(name, value) {
    const text = value == null ? "" : String(value).trim();
    const area = text === "" ? null : Math.round(Number(text) * 100) / 100;
    if (area !== null && !(area > 0 && area < 100000)) throw new Error("Area must be a number of hectares, more than 0");
    this.data.info ??= {};
    this.data.info[name] = { ...this.data.info[name], area };
    this.save();
    return area;
  }

  /** The two paddock slots for a half-day: ["", ""] when nothing is entered. */
  getSlot(key) {
    return this.data.log[key] ? [...this.data.log[key]] : ["", ""];
  }

  setSlot(key, index, paddock) {
    const row = this.getSlot(key);
    row[index] = paddock;
    if (row.every((p) => !p)) delete this.data.log[key];
    else this.data.log[key] = row;
    this.data.updated = new Date().toISOString();
    this.save();
  }

  get photos() {
    return this.data.photos;
  }

  addPhoto(record) {
    this.data.photos.push(record);
    this.save();
  }

  photoNames() {
    return new Set(this.data.photos.map((p) => p.file));
  }
}

function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows) {
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/** Grazing log as CSV rows, oldest first: date, half, paddock_1, paddock_2. */
export function logCsv(store) {
  const keys = Object.keys(store.data.log).sort((a, b) => a.localeCompare(b));
  return toCsv([
    ["date", "half", "paddock_1", "paddock_2"],
    ...keys.map((k) => {
      const [date, half] = k.split(" ");
      return [date, half, ...store.data.log[k]];
    }),
  ]);
}

export function photosCsv(store) {
  return toCsv([
    ["file", "taken", "plus_code", "latitude", "longitude", "accuracy_m", "altitude_m"],
    ...store.photos.map((p) => [p.file, p.taken, p.plusCode, p.lat, p.lng, p.accuracy, p.altitude ?? ""]),
  ]);
}
