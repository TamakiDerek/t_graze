// Background sync to Supabase. The phone stays the first copy: every change is saved locally,
// queued here, and pushed when there's signal. Uses Supabase's plain HTTP APIs (no SDK), so the
// app still has no dependencies and loads offline.
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";

const STATE_KEY = "t_graze_sync";
// Herd size and intake for the feed ahead. Kept here for offline use; the farm's values win on sync.
export const FEED_KEY = "t_graze_feed";
export const FEED_DEFAULTS = { cows: 160, perCow: 20 };
export function feedSettings() {
  try {
    return { ...FEED_DEFAULTS, ...JSON.parse(localStorage.getItem(FEED_KEY) || "{}") };
  } catch {
    return { ...FEED_DEFAULTS };
  }
}
const PULL_DAYS = 120;

// ---------- photo outbox (IndexedDB: photo blobs are too big for localStorage) ----------
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("t_graze", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("photos", { keyPath: "file" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function photoStore(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("photos", mode);
    const result = fn(tx.objectStore("photos"));
    tx.oncomplete = () => resolve(result?.result ?? result);
    tx.onerror = () => reject(tx.error);
  });
}
const queuePhoto = (item) => photoStore("readwrite", (s) => s.put(item));
const pendingPhotos = () => photoStore("readonly", (s) => s.getAll());
export const pendingPhotoFiles = () => photoStore("readonly", (s) => s.getAllKeys());
const dropPhoto = (file) => photoStore("readwrite", (s) => s.delete(file));

class HttpError extends Error {
  constructor(status, body) {
    super(`${status}: ${body?.message || body?.msg || body?.error_description || body?.error || "request failed"}`);
    this.status = status;
    this.body = body;
  }
}

export class Cloud {
  /** @param {import("./model.js").Store} store */
  constructor(store, onChange = () => {}) {
    this.store = store;
    this.onChange = onChange;
    this.busy = false;
    this.error = null;
    this.pendingPhotoCount = 0;
    try {
      this.state = JSON.parse(localStorage.getItem(STATE_KEY) || "{}");
    } catch {
      this.state = {};
    }
    this.state.dirtyLog ??= [];
    this.state.paddockOps ??= [];
    this.state.coverReadings ??= [];
    this.state.photoDeletes ??= [];
    // Another copy of the app on this device (another tab, or the phone view inside the laptop page)
    // may refresh the shared sign-in. Pick its new one up straight away instead of reusing the old
    // refresh token, which Supabase would treat as stolen and sign both copies out.
    if (typeof window !== "undefined") {
      window.addEventListener("storage", (e) => {
        if (e.key === STATE_KEY) this.adoptStoredSession();
      });
    }
  }

  /** Take the sign-in another copy of the app saved, if it's newer than ours. */
  adoptStoredSession() {
    let stored;
    try {
      stored = JSON.parse(localStorage.getItem(STATE_KEY) || "{}");
    } catch {
      return false;
    }
    const mine = this.state.session;
    const theirs = stored.session;
    if (!theirs || (mine && theirs.user_id !== mine.user_id)) return false;
    if (mine && theirs.expires_at <= mine.expires_at) return false;
    this.state.session = theirs;
    for (const k of ["code", "farmId", "farmName"]) this.state[k] ??= stored[k];
    return true;
  }

  get configured() {
    return Boolean(SUPABASE_URL && SUPABASE_KEY);
  }
  get approved() {
    return Boolean(this.state.session && this.state.farmId);
  }
  get waiting() {
    return this.state.dirtyLog.length + this.state.paddockOps.length + this.state.coverReadings.length + this.state.photoDeletes.length + this.pendingPhotoCount;
  }

  saveState() {
    localStorage.setItem(STATE_KEY, JSON.stringify(this.state));
    this.onChange();
  }

  // ---------- change tracking (called by the app after it saves locally) ----------
  logChanged(key) {
    if (!this.state.dirtyLog.includes(key)) this.state.dirtyLog.push(key);
    this.saveState();
    this.soon();
  }
  paddockAdded(name) {
    this.state.paddockOps.push({ op: "add", name });
    this.saveState();
    this.soon();
  }
  paddockRenamed(from, to) {
    this.state.paddockOps.push({ op: "rename", from, to });
    for (const r of this.state.coverReadings) if (r.paddock === from) r.paddock = to;
    // area ops queued before the rename go ahead of it, so they keep the old name (PATCH runs first)
    this.saveState();
    this.soon();
  }
  paddockAreaSet(name, area) {
    this.state.paddockOps.push({ op: "area", name, area });
    this.saveState();
    this.soon();
  }
  paddockRotationSet(name, inRotation) {
    this.state.paddockOps.push({ op: "rotation", name, inRotation });
    this.saveState();
    this.soon();
  }
  paddockRemoved(name) {
    this.state.paddockOps.push({ op: "remove", name });
    this.saveState();
    this.soon();
  }
  /** A measured cover (from measureCover). Re-measuring the same paddock the same day replaces it. */
  coverMeasured(reading) {
    this.state.coverReadings = this.state.coverReadings.filter((r) => !(r.paddock === reading.paddock && r.day === reading.day));
    this.state.coverReadings.push(reading);
    this.saveState();
    this.soon();
  }
  /** Herd size / intake changed on this phone: shared with the whole farm on the next sync. */
  feedChanged(cows, perCow) {
    localStorage.setItem(FEED_KEY, JSON.stringify({ cows, perCow }));
    this.state.feedDirty = true;
    this.saveState();
    this.soon(3000);
  }
  async photoTaken(meta, blob) {
    await queuePhoto({ file: meta.file, meta, blob });
    await this.countPhotos();
    this.soon();
  }
  /** A photo was deleted on this phone: drop it from the upload queue and from the farm's database. */
  async photoDeleted(file) {
    await dropPhoto(file);
    if (!this.state.photoDeletes.includes(file)) this.state.photoDeletes.push(file);
    this.saveState();
    await this.countPhotos();
    this.soon();
  }
  async countPhotos() {
    this.pendingPhotoCount = (await pendingPhotos()).length;
    this.onChange();
  }
  async isPending(file) {
    return (await pendingPhotos()).some((p) => p.file === file);
  }

  soon(ms = 1500) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.sync(), ms);
  }

  // ---------- HTTP ----------
  async request(path, { method = "GET", body, headers = {}, auth = true, raw = false } = {}) {
    if (auth) await this.freshToken();
    const res = await fetch(SUPABASE_URL + path, {
      method,
      headers: {
        apikey: SUPABASE_KEY,
        ...(auth ? { Authorization: `Bearer ${this.state.session.access_token}` } : {}),
        ...(body && !raw ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body == null ? undefined : raw ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { message: text };
    }
    if (!res.ok) throw new HttpError(res.status, data);
    return data;
  }

  async freshToken() {
    this.adoptStoredSession();
    const s = this.state.session;
    if (!s) throw new HttpError(401, { message: "not signed in" });
    if (Date.now() < s.expires_at - 60_000) return;
    try {
      this.setSession(await this.request("/auth/v1/token?grant_type=refresh_token", {
        method: "POST", auth: false, body: { refresh_token: s.refresh_token },
      }));
    } catch (err) {
      // Another copy of the app may have refreshed it a moment ago: use that one.
      if (this.adoptStoredSession() && Date.now() < this.state.session.expires_at - 60_000) return;
      if (err.status >= 400 && err.status < 500) {
        // Session revoked or expired: the phone registers again with a new code and needs
        // approving again. Queued data is kept and uploads after that.
        this.state.session = null;
        this.state.code = null;
        this.state.farmId = null;
        this.saveState();
      }
      throw err;
    }
  }

  setSession(t) {
    this.state.session = {
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      expires_at: Date.now() + t.expires_in * 1000,
      user_id: t.user?.id ?? this.state.session?.user_id,
    };
    this.saveState();
  }

  // ---------- this phone ----------
  // No passwords: the phone signs itself in anonymously and registers a short code. Approving
  // that code in Supabase (select public.approve_phone('3F9A21', 'Farm name')) links it to a farm.

  /** "3F9-A21", or null before the phone has registered. */
  get displayCode() {
    return this.state.code ? `${this.state.code.slice(0, 3)}-${this.state.code.slice(3)}` : null;
  }

  async register() {
    if (!this.state.session) {
      this.setSession(await this.request("/auth/v1/signup", { method: "POST", auth: false, body: {} }));
      this.state.code = null;
      this.state.farmId = null;
    }
    if (!this.state.code) {
      const code = this.state.session.user_id.replace(/-/g, "").slice(0, 6).toUpperCase();
      try {
        await this.request("/rest/v1/devices", {
          method: "POST",
          headers: { Prefer: "return=minimal" },
          body: {
            code,
            user_agent: navigator.userAgent.slice(0, 200),
            owner_name: this.state.owner?.name || null,
            owner_email: this.state.owner?.email || null,
          },
        });
      } catch (err) {
        if (err.status !== 409) throw err; // 409: already registered on an earlier try
      }
      this.state.code = code;
      this.saveState();
    }
  }

  /** Who this phone belongs to, so whoever approves phones can tell them apart. */
  setOwner(name, email) {
    this.state.owner = { name: name.trim(), email: email.trim() };
    this.state.ownerDirty = true;
    this.saveState();
    this.soon(200);
  }

  async pushOwner() {
    if (!this.state.ownerDirty || !this.state.code) return;
    await this.request(`/rest/v1/devices?user_id=eq.${this.state.session.user_id}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: { owner_name: this.state.owner?.name || null, owner_email: this.state.owner?.email || null },
    });
    this.state.ownerDirty = false;
    this.saveState();
  }

  /** True once the phone has been approved for a farm. */
  async checkApproval() {
    const farms = await this.request(
      `/rest/v1/farm_members?select=farm_id,farms(name)&user_id=eq.${this.state.session.user_id}`);
    if (!farms.length) return false;
    this.state.farmId = farms[0].farm_id;
    this.state.farmName = farms[0].farms?.name ?? "";
    // Everything already on the phone goes up with the first sync.
    this.state.dirtyLog = Object.keys(this.store.data.log);
    this.state.paddockOps = this.store.paddocks.flatMap((name) => [
      { op: "add", name },
      ...(this.store.area(name) != null ? [{ op: "area", name, area: this.store.area(name) }] : []),
      ...(this.store.isOut(name) ? [{ op: "rotation", name, inRotation: false }] : []),
    ]);
    this.state.feedDirty = Boolean(localStorage.getItem(FEED_KEY));
    this.saveState();
    return true;
  }

  // ---------- sync ----------
  async sync() {
    if (!this.configured || this.busy || !navigator.onLine) return;
    this.busy = true;
    this.onChange();
    try {
      await this.register();
      await this.pushOwner();
      if (!this.approved && !(await this.checkApproval())) {
        this.error = null; // waiting for approval is not an error
        return;
      }
      await this.pushPaddocks();
      await this.pushLog();
      await this.pushCovers();
      await this.pushFeed();
      await this.pushPhotos();
      await this.pushPhotoDeletes();
      await this.pull();
      this.state.lastSync = new Date().toISOString();
      this.error = null;
    } catch (err) {
      this.error = err.message || String(err);
      console.warn("sync:", err);
    } finally {
      this.busy = false;
      this.saveState();
    }
  }

  async pushPaddocks() {
    const farm = this.state.farmId;
    while (this.state.paddockOps.length) {
      const op = this.state.paddockOps[0];
      try {
        if (op.op === "add") {
          await this.request("/rest/v1/paddocks?on_conflict=farm_id,name", {
            method: "POST",
            headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
            body: { farm_id: farm, name: op.name },
          });
        } else if (op.op === "rename") {
          await this.request("/rest/v1/rpc/rename_paddock", {
            method: "POST", body: { f: farm, old_name: op.from, new_name: op.to },
          });
        } else if (op.op === "area") {
          await this.request(`/rest/v1/paddocks?farm_id=eq.${farm}&name=eq.${encodeURIComponent(op.name)}`, {
            method: "PATCH", headers: { Prefer: "return=minimal" }, body: { area_ha: op.area },
          });
        } else if (op.op === "rotation") {
          await this.request(`/rest/v1/paddocks?farm_id=eq.${farm}&name=eq.${encodeURIComponent(op.name)}`, {
            method: "PATCH", headers: { Prefer: "return=minimal" }, body: { in_rotation: op.inRotation },
          });
        } else if (op.op === "remove") {
          await this.request(`/rest/v1/paddocks?farm_id=eq.${farm}&name=eq.${encodeURIComponent(op.name)}`, {
            method: "DELETE", headers: { Prefer: "return=minimal" },
          });
        }
      } catch (err) {
        // 409: same paddock already there in another case ("haybarn") - nothing to do.
        if (err.status !== 409) throw err;
      }
      this.state.paddockOps.shift();
      this.saveState();
    }
  }

  async pushLog() {
    const farm = this.state.farmId;
    const keys = [...this.state.dirtyLog];
    const upserts = [];
    for (const key of keys) {
      const [day, half] = key.split(" ");
      const row = this.store.data.log[key];
      if (row) {
        upserts.push({ farm_id: farm, day, half, paddock_1: row[0] || null, paddock_2: row[1] || null, updated_at: new Date().toISOString() });
      } else {
        await this.request(`/rest/v1/grazing_log?farm_id=eq.${farm}&day=eq.${day}&half=eq.${half}`, {
          method: "DELETE", headers: { Prefer: "return=minimal" },
        });
      }
    }
    if (upserts.length) {
      await this.request("/rest/v1/grazing_log?on_conflict=farm_id,day,half", {
        method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: upserts,
      });
    }
    // Only clear what was sent; anything edited meanwhile stays queued.
    this.state.dirtyLog = this.state.dirtyLog.filter((k) => !keys.includes(k));
    this.saveState();
  }

  async pushCovers() {
    const farm = this.state.farmId;
    const sent = [...this.state.coverReadings];
    if (!sent.length) return;
    await this.request("/rest/v1/cover_readings?on_conflict=farm_id,paddock,day", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: sent.map((r) => ({ farm_id: farm, ...r, entered_at: new Date().toISOString() })),
    });
    this.state.coverReadings = this.state.coverReadings.filter((r) => !sent.includes(r));
    this.saveState();
  }

  async pushFeed() {
    if (!this.state.feedDirty) return;
    const { cows, perCow } = feedSettings();
    await this.request(`/rest/v1/farms?id=eq.${this.state.farmId}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: { herd_cows: cows, intake_kg: perCow, feed_updated_at: new Date().toISOString() },
    });
    this.state.feedDirty = false;
    this.saveState();
  }

  async pushPhotoDeletes() {
    const farm = this.state.farmId;
    while (this.state.photoDeletes.length) {
      const file = this.state.photoDeletes[0];
      try {
        await this.request(`/storage/v1/object/photos/${farm}/${encodeURIComponent(file)}`, { method: "DELETE" });
      } catch (err) {
        if (err.status !== 400 && err.status !== 404) throw err; // never uploaded: nothing to delete
      }
      await this.request(`/rest/v1/photos?farm_id=eq.${farm}&file=eq.${encodeURIComponent(file)}`, {
        method: "DELETE", headers: { Prefer: "return=minimal" },
      });
      this.state.photoDeletes.shift();
      this.saveState();
    }
  }

  async pushPhotos() {
    const farm = this.state.farmId;
    for (const { file, meta, blob } of await pendingPhotos()) {
      const path = `${farm}/${file}`;
      await this.request(`/storage/v1/object/photos/${farm}/${encodeURIComponent(file)}`, {
        method: "POST", raw: true, body: blob, headers: { "Content-Type": "image/jpeg", "x-upsert": "true" },
      });
      await this.request("/rest/v1/photos?on_conflict=farm_id,file", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: {
          farm_id: farm, file, taken_at: meta.taken, plus_code: meta.plusCode, latitude: meta.lat,
          longitude: meta.lng, accuracy_m: meta.accuracy, altitude_m: meta.altitude, storage_path: path,
        },
      });
      const record = this.store.photos.find((p) => p.file === file);
      if (record) {
        record.uploaded = true;
        this.store.save();
      }
      await dropPhoto(file);
      await this.countPhotos();
    }
  }

  // Brings in paddocks and log rows entered on other phones. Local rows still waiting to upload win.
  async pull() {
    const farm = this.state.farmId;
    const since = new Date(Date.now() - PULL_DAYS * 86_400_000).toISOString().slice(0, 10);
    const [paddocks, rows, farms] = await Promise.all([
      this.request(`/rest/v1/paddocks?select=name,cover,cover_date,cover_method,area_ha,in_rotation&farm_id=eq.${farm}`),
      this.request(`/rest/v1/grazing_log?select=day,half,paddock_1,paddock_2&farm_id=eq.${farm}&day=gte.${since}`),
      this.request(`/rest/v1/farms?select=herd_cows,intake_kg&id=eq.${farm}`),
    ]);
    // Farm-wide herd size and intake. If the farm has none yet, this phone's own numbers (if it
    // ever changed them) become the farm's on the next sync.
    const f = farms[0];
    if (f && f.herd_cows != null && f.intake_kg != null) {
      if (!this.state.feedDirty) localStorage.setItem(FEED_KEY, JSON.stringify({ cows: f.herd_cows, perCow: Number(f.intake_kg) }));
    } else if (localStorage.getItem(FEED_KEY)) {
      this.state.feedDirty = true;
    }
    const data = this.store.data;
    const pendingNames = new Set(this.state.paddockOps.flatMap((o) => [o.name, o.from, o.to]));
    data.covers = {};
    data.info ??= {};
    const pendingAreas = new Set(this.state.paddockOps.filter((o) => o.op === "area").map((o) => o.name));
    const pendingRotation = new Set(this.state.paddockOps.filter((o) => o.op === "rotation").map((o) => o.name));
    for (const { name, cover, cover_date, cover_method, area_ha, in_rotation } of paddocks) {
      if (!this.store.findPaddock(name) && !pendingNames.has(name)) data.paddocks.push(name);
      const local = this.store.findPaddock(name) ?? name;
      if (cover != null && cover_date) data.covers[local] = { value: cover, date: cover_date, method: cover_method ?? "typed" };
      if (!pendingAreas.has(local)) data.info[local] = { ...data.info[local], area: area_ha == null ? null : Number(area_ha) };
      if (!pendingRotation.has(local) && in_rotation != null) data.info[local] = { ...data.info[local], out: !in_rotation };
    }
    // Readings still waiting to upload stay showing.
    for (const r of this.state.coverReadings) {
      const name = this.store.findPaddock(r.paddock) ?? r.paddock;
      if (!data.covers[name] || data.covers[name].date <= r.day) data.covers[name] = { value: r.cover, date: r.day, method: r.method ?? "typed" };
    }
    const dirty = new Set(this.state.dirtyLog);
    const remote = new Set();
    for (const r of rows) {
      const key = `${r.day} ${r.half}`;
      remote.add(key);
      if (!dirty.has(key)) data.log[key] = [r.paddock_1 || "", r.paddock_2 || ""];
    }
    // A row cleared on another phone: drop it here too (only inside the pulled window).
    for (const key of Object.keys(data.log)) {
      if (key >= since && !remote.has(key) && !dirty.has(key)) delete data.log[key];
    }
    this.store.save();
  }
}
