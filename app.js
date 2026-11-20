import { Store, slots, currentHalf, isoDate, photoName, logCsv, photosCsv } from "./model.js";
import { encode, shortCode } from "./pluscode.js";
import { insertExif } from "./exif.js";

const store = new Store(localStorage);
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
      renderPaddockOptions();
      toast(`Added "${paddock}" to the paddock list`);
    }
  }
  input.value = paddock;
  input.dataset.saved = paddock;
  store.setSlot(input.dataset.key, Number(input.dataset.index), paddock);
});

$("log-rows").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && event.target instanceof HTMLInputElement) event.target.blur();
});

$("more").addEventListener("click", () => {
  weeksShown += 4;
  renderLog();
});

// ---------- paddocks ----------
function lastGrazed() {
  const last = new Map();
  for (const key of Object.keys(store.data.log).sort()) {
    for (const p of store.data.log[key]) if (p) last.set(p, key);
  }
  return last;
}

function describeLast(key) {
  if (!key) return "not grazed yet";
  const [date, half] = key.split(" ");
  const [y, m, d] = date.split("-").map(Number);
  const then = new Date(y, m - 1, d);
  const today = new Date();
  const days = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()) - then) / 86_400_000);
  const label = then.toLocaleDateString("en", { month: "short", day: "numeric" });
  return `last grazed ${label} ${half} · ${days === 0 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`}`;
}

function renderPaddocks() {
  const last = lastGrazed();
  const items = store.paddocks.map((name) => {
    const li = document.createElement("li");
    li.innerHTML = `<div class="main"><div class="name"></div><div class="sub"></div></div>
      <button type="button" data-act="rename">Rename</button>
      <button type="button" data-act="remove">Remove</button>`;
    li.querySelector(".name").textContent = name;
    li.querySelector(".sub").textContent = describeLast(last.get(name));
    li.dataset.name = name;
    return li;
  });
  if (!items.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No paddocks yet. Add them here, or just type them into the grazing table.";
    items.push(li);
  }
  $("paddock-list").replaceChildren(...items);
}

$("paddock-list").addEventListener("click", (event) => {
  const btn = event.target.closest("button[data-act]");
  if (!btn) return;
  const name = btn.closest("li").dataset.name;
  try {
    if (btn.dataset.act === "rename") {
      const next = prompt(`Rename "${name}" to:`, name);
      if (next == null || next.trim() === name) return;
      const clean = store.renamePaddock(name, next);
      toast(`Renamed to "${clean}" (grazing log updated)`);
    } else {
      const uses = store.paddockUses(name);
      if (uses) {
        toast(`"${name}" is in the grazing log ${uses} time(s) - rename it instead, or clear those entries first.`, true);
        return;
      }
      if (!confirm(`Remove "${name}" from the paddock list?`)) return;
      store.removePaddock(name);
    }
  } catch (err) {
    toast(err.message, true);
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
    download(new Blob([tagged], { type: "image/jpeg" }), name);

    store.addPhoto({
      file: name,
      taken: time.toISOString(),
      plusCode,
      lat: Number(lat.toFixed(7)),
      lng: Number(lng.toFixed(7)),
      accuracy: Math.round(accuracy * 10) / 10,
      altitude: altitude == null ? null : Math.round(altitude * 10) / 10,
    });
    toast(`Saved ${name}`);
    if (!$("tab-photos").hidden) renderPhotos();
  } catch (err) {
    const msg = err?.code === 1 ? "Location permission is needed to name photos." : err?.message || String(err);
    toast(`Photo not saved: ${msg}`, true);
  } finally {
    renderGps();
  }
});

function renderPhotos() {
  const items = [...store.photos].reverse().map((p) => {
    const li = document.createElement("li");
    li.innerHTML = `<div class="main"><div class="name"></div><div class="sub"></div></div>`;
    li.querySelector(".name").textContent = p.file;
    const when = new Date(p.taken).toLocaleString("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    li.querySelector(".sub").textContent = `${when} · ${p.plusCode} · ±${Math.round(p.accuracy)} m`;
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

// ---------- start ----------
renderPaddockOptions();
renderLog();
startGps();
renderGps();

// Re-render when the app comes back to the front, so the "now" row moves on after midday/midnight.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !$("tab-log").hidden && !document.activeElement?.matches("input")) renderLog();
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch((err) => console.warn("service worker:", err));
}
