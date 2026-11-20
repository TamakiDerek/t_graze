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

const EMPTY = () => ({ version: 1, paddocks: [], log: {}, photos: [], covers: {} });

const DAY_MS = 86_400_000;
const dayNumber = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
};

/**
 * Per-paddock figures for the Paddocks table.
 * A paddock grazed on days that touch (same day or the next day) counts as one visit.
 * - lastDays: days from the latest entry to today (0 = today)
 * - interval: days between the start of the previous visit and the start of the latest one
 * - cover: from the database (derived on the laptop side); null until set
 */
export function paddockStats(store, now) {
  const today = dayNumber(isoDate(now));
  const days = new Map(); // paddock -> sorted unique day numbers it appears on
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
    const visitStarts = list.filter((d, i) => i === 0 || d - list[i - 1] > 1);
    const cover = store.data.covers?.[name];
    return {
      name,
      lastDays: list.length ? today - list[list.length - 1] : null,
      interval: visitStarts.length > 1 ? visitStarts.at(-1) - visitStarts.at(-2) : null,
      cover: Number.isFinite(cover) ? cover : null,
    };
  });
}

/** Default direction when a column is first tapped: days smallest first, cover largest first. */
export const SORT_DEFAULTS = { name: "asc", lastDays: "asc", cover: "desc", interval: "asc" };

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
    if (this.data.covers && oldName in this.data.covers) {
      this.data.covers[clean] = this.data.covers[oldName];
      if (clean !== oldName) delete this.data.covers[oldName];
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
    this.save();
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
