import { Store, slots, currentHalf, isoDate, photoName, logCsv, photosCsv, paddockStats, sortPaddockStats, SORT_DEFAULTS, measureCover, coverRanking, forecastFeed } from "./model.js";
import { encode, shortCode } from "./pluscode.js";
import { insertExif } from "./exif.js";
import { Cloud, pendingPhotoFiles, feedSettings } from "./cloud.js";

const store = new Store(localStorage);
let wasBusy = false;
const cloud = new Cloud(store, () => {
  renderSync();
  if (wasBusy && !cloud.busy) refreshAfterSync();
  wasBusy = cloud.busy;
});
const $ = (id) => document.getElementById(id);
const FIX_MAX_AGE_MS = 60_000; // a GPS fix older than this is refreshed before a photo is named
let weeksShown = 6;
let lastFix = null; // GeolocationPosition
let gpsError = null;

navigator.storage?.persist?.(); // ask Chrome not to evict the log under storage pressure

// ---------- toast ----------
let toastTimer;
function toast(message, isError = false) {
  const el = $("toast");
  el.textContent = message;
  el.classList.toggle("error", isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), isError ? 6000 : 3500);
}

// ---------- tabs ----------
for (const btn of document.querySelectorAll("[data-tab]")) {
  btn.addEventListener("click", () => showTab(btn.dataset.tab));
}
function showTab(name) {
  for (const btn of document.querySelectorAll("[data-tab]")) {
    btn.setAttribute("aria-selected", String(btn.dataset.tab === name));
  }
  for (const sec of document.querySelectorAll(".tab")) sec.hidden = sec.id !== `tab-${name}`;
  if (name === "log") renderLog();
  if (name === "photos") renderPhotos();
  if (name === "paddocks") renderPaddocks();
  if (name === "analysis") renderAnalysis();
}

// ---------- analysis ----------
const CHART_MIN = 1000;
const CHART_MAX = 4000;
const kg = (n) => n.toLocaleString("en-NZ");
const barPct = (cover) => Math.max(0, Math.min(1, (cover - CHART_MIN) / (CHART_MAX - CHART_MIN))) * 100;
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
/** One horizontal bar from 1000 to 4000 with its value written after it. */
function barCell(cover, kind) {
  const track = el("span", "track");
  const fill = el("span", `fill ${kind}`);
  fill.style.width = `${barPct(cover)}%`;
  track.append(fill, el("span", "cval", cover));
  return track;
}
function chartHead(first, last) {
  const head = el("div", "chart-row chart-head");
  head.append(el("span", null, first));
  const ticks = el("span", "ticks");
  for (const v of [1000, 2000, 3000, 4000]) ticks.append(el("i", null, v));
  head.append(ticks, el("span", "avail", last));
  return head;
}

function renderAnalysis() {
  const rows = coverRanking(store, new Date());
  const chart = $("cover-chart");
  chart.replaceChildren(chartHead("Paddock", "Avail. kg"));
  for (const r of rows) {
    const row = el("div", r.out ? "chart-row out" : "chart-row");
    const name = el("button", "pname", r.name);
    name.type = "button";
    name.dataset.name = r.name;
    name.setAttribute("aria-pressed", String(!r.out));
    name.title = `${r.name}: ${r.out ? "out of the rotation - tap to put back in" : "in the rotation - tap to take out"}`;
    row.title = `${r.name}: ${r.cover} kg DM/ha ${r.coverKind === "m" ? `(measured ${r.coverAge} days ago)` : "(estimate)"}` +
      (r.area != null ? `, ${r.area} ha` : "");
    row.append(name, barCell(r.cover, r.out ? "off" : r.coverKind), el("span", "avail", r.out ? "out" : r.available == null ? "–" : kg(r.available)));
    chart.append(row);
  }
  if (!rows.length) chart.append(el("p", "hint", "No paddock has a cover yet: enter grazings or measured covers first."));
  const known = rows.filter((r) => r.available != null && !r.out);
  $("chart-total").textContent = known.length ? `· in rotation ${kg(known.reduce((s, r) => s + r.available, 0))} kg DM available` : "";
  renderFeed();
}

// Tap a paddock name in the cover chart: take it out of the rotation, or put it back in.
$("cover-chart").addEventListener("click", (event) => {
  const btn = event.target.closest("button.pname");
  if (!btn) return;
  const name = btn.dataset.name;
  const out = !store.isOut(name);
  store.setOut(name, out);
  cloud.paddockRotationSet(name, !out);
  toast(out ? `${name} out of the rotation (not grazed in the feed ahead)` : `${name} back in the rotation`);
  renderAnalysis();
});

// Feed ahead: herd size and intake are a farm setting, shared by every phone (saved here for offline use).
function showFeedInputs() {
  const { cows, perCow } = feedSettings();
  for (const [id, v] of [["feed-cows", cows], ["feed-per", perCow]]) {
    if (document.activeElement !== $(id)) $(id).value = v;
  }
}
showFeedInputs();
$("feed-form").addEventListener("input", () => {
  const cows = Number($("feed-cows").value);
  const perCow = Number($("feed-per").value);
  if ($("feed-cows").value !== "" && $("feed-per").value !== "" && cows >= 0 && perCow >= 0) cloud.feedChanged(cows, perCow);
  renderFeed();
});
$("feed-form").addEventListener("submit", (e) => e.preventDefault());
// Go / Done on the phone keyboard: keep the number and close the keyboard.
$("feed-form").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target instanceof HTMLInputElement) {
    e.preventDefault();
    e.target.blur();
  }
});

const shortDate = (iso) => new Date(iso + "T12:00").toLocaleDateString("en-NZ", { day: "numeric", month: "short" });
const dayLabel = (iso) => new Date(iso + "T12:00").toLocaleDateString("en-NZ", { weekday: "short", day: "numeric" });

/** Feed ahead, drawn like the cover chart: one row per day, a bar for the average farm cover. */
function renderFeed() {
  showFeedInputs();
  const { cows, perCow } = feedSettings();
  const f = forecastFeed(store, new Date(), { cows, perCow });
  $("feed-demand").textContent = `= ${kg(f.demand)} kg DM a day`;
  const chart = $("feed-chart");
  chart.replaceChildren();
  if (!f.days.some((d) => d.afc != null)) {
    $("feed-note").textContent = "No paddock in the rotation has both a cover and an area yet.";
    return;
  }
  const head = chartHead("Day", "Avail. kg");
  head.append(el("span", "grazed", "Grazed"));
  chart.append(head);
  for (const d of f.days) {
    const row = el("div", d.shortfall ? "chart-row short" : "chart-row");
    const grazed = d.grazed.map((g) => g.name + (g.finished ? "" : "…")).join(", ") + (d.shortfall ? ` short ${kg(d.shortfall)}` : "");
    row.title = `${shortDate(d.date)}: average cover ${d.afc} kg DM/ha, ${kg(d.available)} kg available` + (grazed ? `; ${grazed}` : "");
    row.append(el("span", "day", d === f.days[0] ? "Today" : dayLabel(d.date)), barCell(d.afc, "e"), el("span", "avail", kg(d.available)), el("span", "grazed", grazed));
    chart.append(row);
  }
  const shortDays = f.days.filter((d) => d.shortfall);
  $("feed-note").textContent = `Average cover over ${f.area} ha in the rotation` +
    (f.out.length ? `; out of the rotation: ${f.out.join(", ")}` : "") +
    (f.excluded.length ? `; no cover or area yet: ${f.excluded.join(", ")}` : "") +
    (shortDays.length ? `. Not enough feed from ${shortDate(shortDays[0].date)}: short ${kg(shortDays.reduce((s, d) => s + d.shortfall, 0))} kg DM over the 3 weeks.` : ".");
}

// ---------- grazing log ----------
function renderPaddockOptions() {
  const list = $("paddock-names");
  list.replaceChildren(...store.paddocks.map((p) => Object.assign(document.createElement("option"), { value: p })));
}

function renderLog() {
  const now = new Date();
  const nowKey = `${isoDate(now)} ${currentHalf(now)}`;
  const rows = slots(now, weeksShown * 7).map((slot) => {
    const tr = document.createElement("tr");
    tr.className = slot.half + (slot.key === nowKey ? " now" : "");
    const label = document.createElement("td");
    label.textContent = slot.label;
    tr.append(label);
    store.getSlot(slot.key).forEach((value, index) => {
      const td = document.createElement("td");
      const input = document.createElement("input");
      Object.assign(input, { value, autocomplete: "off", enterKeyHint: "done", spellcheck: false });
      input.setAttribute("list", "paddock-names");
      input.setAttribute("aria-label", `${slot.label} paddock ${index + 1}`);
      input.dataset.key = slot.key;
      input.dataset.index = String(index);
      input.dataset.saved = value;
      td.append(input);
      tr.append(td);
    });
    return tr;
  });
  $("log-rows").replaceChildren(...rows);
}

$("log-rows").addEventListener("change", (event) => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) return;
  const typed = input.value.trim().replace(/\s+/g, " ");
  let paddock = "";
  if (typed) {
    paddock = store.findPaddock(typed);
    if (!paddock) {
      if (!confirm(`New paddock "${typed}" - add to list?`)) {
        input.value = input.dataset.saved; // put back what was there; nothing saved
        return;
      }
      paddock = store.addPaddock(typed);
      cloud.paddockAdded(paddock);
      renderPaddockOptions();
      toast(`Added "${paddock}" to the paddock list`);
    }
  }
  input.value = paddock;
  input.dataset.saved = paddock;
  store.setSlot(input.dataset.key, Number(input.dataset.index), paddock);
  cloud.logChanged(input.dataset.key);
});

$("log-rows").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && event.target instanceof HTMLInputElement) event.target.blur();
});

$("more").addEventListener("click", () => {
  weeksShown += 4;
  renderLog();
});

// ---------- paddocks ----------
const SORT_KEY = "t_graze_paddock_sort_v2"; // v2: Last grazed now defaults to largest first
let paddockSort = { key: "lastDays", dir: SORT_DEFAULTS.lastDays };
try {
  const saved = JSON.parse(localStorage.getItem(SORT_KEY) || "null");
  if (saved && saved.key in SORT_DEFAULTS) paddockSort = saved;
} catch {
  /* keep the default */
}

const num = (v) => (v == null ? "–" : String(v));

function renderPaddocks() {
  for (const th of document.querySelectorAll("#tab-paddocks th[data-sort]")) {
    const on = th.dataset.sort === paddockSort.key;
    th.setAttribute("aria-sort", on ? (paddockSort.dir === "asc" ? "ascending" : "descending") : "none");
    th.querySelector(".arrow").textContent = on ? (paddockSort.dir === "asc" ? "▲" : "▼") : "";
  }
  const rows = sortPaddockStats(paddockStats(store, new Date()), paddockSort.key, paddockSort.dir).map((r) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td class="name"></td><td class="mid"></td><td class="num"></td><td class="mid"></td>
      <td><button type="button" class="edit" aria-label="Edit">✏️</button></td>`;
    const cells = tr.querySelectorAll("td");
    cells[0].textContent = r.name;
    cells[1].textContent = num(r.lastDays);
    if (r.cover == null) {
      cells[2].textContent = "–";
    } else {
      const tag = document.createElement("span");
      tag.className = `tag ${r.coverKind}`;
      tag.textContent = r.coverKind === "m" ? `m${r.coverAge}` : "e";
      tag.title = r.coverKind === "m" ? `Measured ${r.coverFrom.cover} ${r.coverAge} day(s) ago, grown since` : "Estimated";
      cells[2].append(String(r.cover), tag);
    }
    cells[3].textContent = num(r.interval);
    tr.querySelector("button").dataset.name = r.name;
    tr.querySelector("button").setAttribute("aria-label", `Edit ${r.name}`);
    return tr;
  });
  if (!rows.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="5" class="empty">No paddocks yet. Add them here, or just type them into the grazing table.</td>`;
    rows.push(tr);
  }
  $("paddock-rows").replaceChildren(...rows);
}

for (const th of document.querySelectorAll("#tab-paddocks th[data-sort]")) {
  th.querySelector("button").addEventListener("click", () => {
    const key = th.dataset.sort;
    paddockSort = key === paddockSort.key
      ? { key, dir: paddockSort.dir === "asc" ? "desc" : "asc" }
      : { key, dir: SORT_DEFAULTS[key] };
    try {
      localStorage.setItem(SORT_KEY, JSON.stringify(paddockSort));
    } catch {
      /* sorting still works for this visit */
    }
    renderPaddocks();
  });
}

// Edit (pencil): rename or remove one paddock, or enter a measured cover.
let editing = null;
$("paddock-rows").addEventListener("click", (event) => {
  const btn = event.target.closest("button.edit");
  if (!btn) return;
  editing = btn.dataset.name;
  const uses = store.paddockUses(editing);
  $("edit-title").textContent = editing;
  $("edit-name").value = "";
  $("edit-cover").value = "";
  $("edit-area").value = store.area(editing) ?? "";
  $("edit-remove").disabled = uses > 0;
  $("edit-note").textContent = uses
    ? `Used in the grazing log ${uses} time(s), so it can be renamed (the log follows) but not removed.`
    : "Not used in the grazing log.";
  $("edit-dialog").showModal();
});

$("edit-form").addEventListener("submit", (event) => {
  const action = event.submitter?.value;
  if (action === "cancel" || !editing) return;
  try {
    if (action === "save") {
      const next = $("edit-name").value.trim() || editing;
      const coverText = $("edit-cover").value.trim();
      const coverValue = Number(coverText);
      if (coverText && !(coverValue >= 0 && coverValue <= 10000)) throw new Error("Cover must be a number from 0 to 10000");
      const areaText = $("edit-area").value.trim();
      if (areaText && !(Number(areaText) > 0)) throw new Error("Area must be a number of hectares, more than 0");
      const done = [];
      let name = editing;
      if (next.trim() !== editing) {
        name = store.renamePaddock(editing, next);
        if (name !== editing) cloud.paddockRenamed(editing, name);
        done.push(`Renamed to "${name}" (grazing log updated)`);
      }
      const oldArea = store.area(name);
      const newArea = areaText === "" ? null : Math.round(Number(areaText) * 100) / 100;
      if (newArea !== oldArea) {
        cloud.paddockAreaSet(name, store.setArea(name, newArea));
        done.push(newArea == null ? `Area cleared for ${name}` : `${name} is ${newArea} ha`);
      }
      if (coverText) {
        const reading = measureCover(store, name, coverText, new Date());
        cloud.coverMeasured(reading);
        done.push(`Cover ${reading.cover} saved for ${name}` + (reading.predicted != null ? ` (was showing ${reading.predicted})` : ""));
      }
      if (!done.length) return;
      toast(done.join(". "));
    } else if (action === "remove") {
      if (!confirm(`Remove "${editing}" from the paddock list?`)) {
        event.preventDefault();
        return;
      }
      store.removePaddock(editing);
      cloud.paddockRemoved(editing);
      toast(`Removed "${editing}"`);
    }
  } catch (err) {
    event.preventDefault(); // keep the dialog open so the name can be fixed
    toast(err.message, true);
    return;
  }
  renderPaddockOptions();
  renderPaddocks();
});

$("add-paddock").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("new-paddock");
  const typed = input.value.trim();
  if (!typed) return;
  const existing = store.findPaddock(typed);
  const name = store.addPaddock(typed);
  if (!existing) cloud.paddockAdded(name);
  toast(existing ? `"${name}" is already on the list` : `Added "${name}"`);
  input.value = "";
  renderPaddockOptions();
  renderPaddocks();
});

// ---------- export ----------
function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const stamp = () => {
  const d = new Date();
  return `${isoDate(d).replace(/-/g, "")}_${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
};
$("export-log").addEventListener("click", () =>
  download(new Blob([logCsv(store)], { type: "text/csv" }), `t_graze_log_${stamp()}.csv`));
$("export-photos").addEventListener("click", () =>
  download(new Blob([photosCsv(store)], { type: "text/csv" }), `t_graze_photos_${stamp()}.csv`));

// ---------- GPS ----------
function fixIsFresh(fix) {
  return fix && Date.now() - fix.timestamp < FIX_MAX_AGE_MS;
}

function renderGps() {
  const el = $("gps");
  const ok = fixIsFresh(lastFix);
  el.classList.toggle("bad", !ok);
  if (ok) {
    const { latitude, longitude, accuracy } = lastFix.coords;
    el.textContent = `GPS ±${Math.round(accuracy)} m · ${shortCode(encode(latitude, longitude))}`;
  } else if (gpsError?.code === 1) {
    el.textContent = "GPS blocked - tap";
  } else if (gpsError) {
    el.textContent = "GPS off - tap";
  } else {
    el.textContent = "GPS: searching…";
  }
  $("camera").disabled = !ok;
}

function startGps() {
  if (!("geolocation" in navigator)) {
    gpsError = { code: 2 };
    renderGps();
    return;
  }
  navigator.geolocation.watchPosition(
    (pos) => {
      lastFix = pos;
      gpsError = null;
      renderGps();
    },
    (err) => {
      gpsError = err;
      renderGps();
    },
    { enableHighAccuracy: true, maximumAge: 5_000, timeout: 30_000 },
  );
}

$("gps").addEventListener("click", () => {
  if (gpsError?.code === 1) {
    toast("Location is blocked for this app. Allow it in Chrome's site settings (the icon left of the address), then reload.", true);
  } else if (!fixIsFresh(lastFix)) {
    toast("Waiting for GPS. Make sure Location is on and you're outdoors.", true);
  } else {
    const { latitude, longitude } = lastFix.coords;
    toast(`${encode(latitude, longitude)} (${latitude.toFixed(6)}, ${longitude.toFixed(6)})`);
  }
});
setInterval(renderGps, 10_000); // greys out the camera if fixes stop arriving

function freshFix() {
  if (fixIsFresh(lastFix)) return Promise.resolve(lastFix);
  return new Promise((resolve, reject) =>
    navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, maximumAge: 5_000, timeout: 20_000 }));
}

// ---------- camera ----------
$("camera").addEventListener("click", () => {
  if (!fixIsFresh(lastFix)) {
    toast("No GPS fix yet - photos must be geolocated.", true);
    return;
  }
  $("camera-input").click();
});

$("camera-input").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  event.target.value = ""; // so the same file can trigger change again
  if (!file) return;
  const btn = $("camera");
  btn.disabled = true;
  try {
    const fix = await freshFix();
    const time = new Date();
    const { latitude: lat, longitude: lng, accuracy, altitude } = fix.coords;
    const plusCode = encode(lat, lng);
    const name = photoName(time, shortCode(plusCode), store.photoNames());

    // Redraw through a canvas so the pixels are upright, then stamp our own EXIF.
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    bitmap.close?.();
    const jpeg = await new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("could not encode photo"))), "image/jpeg", 0.92));
    const tagged = insertExif(new Uint8Array(await jpeg.arrayBuffer()), {
      lat, lng, altitude, accuracy, time, description: name.replace(/\.jpg$/, ""),
    });
    const photo = new Blob([tagged], { type: "image/jpeg" });
    download(photo, name);

    const meta = {
      file: name,
      taken: time.toISOString(),
      plusCode,
      lat: Number(lat.toFixed(7)),
      lng: Number(lng.toFixed(7)),
      accuracy: Math.round(accuracy * 10) / 10,
      altitude: altitude == null ? null : Math.round(altitude * 10) / 10,
    };
    store.addPhoto(meta);
    await cloud.photoTaken(meta, photo);
    toast(`Saved ${name}`);
    if (!$("tab-photos").hidden) renderPhotos();
  } catch (err) {
    const msg = err?.code === 1 ? "Location permission is needed to name photos." : err?.message || String(err);
    toast(`Photo not saved: ${msg}`, true);
  } finally {
    renderGps();
  }
});

async function renderPhotos() {
  const pending = new Set(await pendingPhotoFiles().catch(() => []));
  const items = [...store.photos].reverse().map((p) => {
    const li = document.createElement("li");
    li.innerHTML = `<div class="main"><div class="name"></div><div class="sub"></div></div>`;
    li.querySelector(".name").textContent = p.file;
    const when = new Date(p.taken).toLocaleString("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const where = p.uploaded ? "uploaded" : pending.has(p.file) ? "waiting to upload" : "on phone only";
    li.querySelector(".sub").textContent = `${when} · ${p.plusCode} · ±${Math.round(p.accuracy)} m · ${where}`;
    return li;
  });
  if (!items.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No photos yet. Tap 📷 to take one.";
    items.push(li);
  }
  $("photo-list").replaceChildren(...items);
}

// ---------- sync ----------
function ago(iso) {
  if (!iso) return "never";
  const mins = Math.round((Date.now() - new Date(iso)) / 60_000);
  return mins < 1 ? "just now" : mins < 60 ? `${mins} min ago` : new Date(iso).toLocaleString("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function renderSync() {
  const chip = $("sync");
  const waiting = cloud.waiting;
  renderOwner();
  chip.classList.toggle("bad", Boolean(cloud.error));
  chip.textContent = cloud.busy ? "☁ …" : !cloud.approved ? "☁ off" : waiting ? `☁ ${waiting}` : "☁ ✓";

  $("waiting").hidden = cloud.approved;
  $("approved").hidden = !cloud.approved;
  $("sync-now").textContent = cloud.approved ? "Sync now" : "Check now";
  if (!cloud.approved) {
    $("phone-code").textContent = cloud.displayCode ?? "…";
    $("waiting-status").textContent = cloud.busy
      ? "Checking…"
      : cloud.error
        ? `Can't reach the database yet: ${cloud.error}`
        : !navigator.onLine
          ? "No signal - the code appears once the phone is online."
          : cloud.displayCode
            ? "Waiting for approval. Fill in your name and email below, then send this code to the farm manager. It checks again every minute."
            : "Registering…";
  } else {
    $("sync-who").textContent = `Approved for ${cloud.state.farmName || "the farm"} · phone ${cloud.displayCode}`
      + (cloud.state.owner?.name ? ` · ${cloud.state.owner.name}` : "");
    $("sync-status").textContent = cloud.busy
      ? "Syncing…"
      : `${waiting ? `${waiting} change(s) waiting to upload` : "Everything uploaded"} · last sync ${ago(cloud.state.lastSync)}`
        + (cloud.error ? ` · last attempt failed: ${cloud.error}` : "");
  }
}

function refreshAfterSync() {
  renderPaddockOptions();
  if (document.activeElement?.matches("#log-rows input")) return; // don't redraw under the farmer's thumb
  if (!$("tab-log").hidden) renderLog();
  if (!$("tab-paddocks").hidden) renderPaddocks();
  if (!$("tab-analysis").hidden) renderAnalysis();
  if (!$("tab-photos").hidden) renderPhotos();
}

$("sync").addEventListener("click", () => {
  if (!cloud.approved) {
    showTab("paddocks");
    $("waiting").scrollIntoView({ block: "center" });
  } else if (!navigator.onLine) toast("No signal - changes are kept on the phone and upload later.");
  else if (cloud.error) toast(`Sync problem: ${cloud.error}`, true);
  else toast(cloud.waiting ? `${cloud.waiting} change(s) waiting to upload` : "Everything uploaded");
  cloud.sync();
});

$("sync-now").addEventListener("click", () => cloud.sync());

function renderOwner() {
  const o = cloud.state.owner;
  if (document.activeElement !== $("owner-name")) $("owner-name").value = o?.name ?? "";
  if (document.activeElement !== $("owner-email")) $("owner-email").value = o?.email ?? "";
  $("owner-status").textContent = !o?.name
    ? "So the farm manager knows whose phone this is."
    : cloud.state.ownerDirty
      ? "Saved on the phone; uploads with the next sync."
      : "Saved.";
}

$("owner-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const name = $("owner-name").value;
  const email = $("owner-email").value;
  if (!name.trim()) {
    toast("Please enter your name", true);
    return;
  }
  if (email.trim() && !$("owner-email").checkValidity()) {
    toast("That email doesn't look right", true);
    return;
  }
  document.activeElement?.blur();
  cloud.setOwner(name, email);
  toast("Name saved");
});

// ---------- layout ----------
// The app bar, tabs and the paddock table's heading row are sticky; each sits under the one above.
function layoutSticky() {
  const bar = document.querySelector(".bar").offsetHeight;
  const tabs = document.querySelector(".tabs").offsetHeight;
  document.documentElement.style.setProperty("--bar-h", `${bar}px`);
  document.documentElement.style.setProperty("--head-h", `${bar + tabs}px`);
}
window.addEventListener("resize", layoutSticky);

// ---------- start ----------
layoutSticky();
renderPaddockOptions();
renderLog();
startGps();
renderGps();
cloud.countPhotos().catch(() => {});
renderSync();
cloud.sync();
window.addEventListener("online", () => cloud.sync());
setInterval(() => {
  if (document.visibilityState === "visible") cloud.sync();
}, 60_000);

// Re-render when the app comes back to the front, so the "now" row moves on after midday/midnight.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (!$("tab-log").hidden && !document.activeElement?.matches("input")) renderLog();
  cloud.sync();
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch((err) => console.warn("service worker:", err));
}
