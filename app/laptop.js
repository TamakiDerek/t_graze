// Laptop side: the farm's photos on an aerial map, each as its plus-code square with the cover
// estimated from it. Click one, say which paddock it is, and accept (or change) the cover: that saves
// the paddock against the photo and adds a cover reading (method "photo") for that paddock and day.
import { Store, measureCover, isoDate, photoDayCover } from "./model.js";
import { Cloud } from "./cloud.js";
import { decode } from "./pluscode.js";
import { SUPABASE_URL, LINZ_BASEMAPS_KEY } from "./config.js";
import { uploadCopy, tiltFromJpeg, UPLOAD_BIG_BYTES } from "./photo-size.js";

const $ = (id) => document.getElementById(id);
const store = new Store(localStorage);
const cloud = new Cloud(store, () => showStatus());
let photos = [];
let chosen = null;
let map = null;
const squares = new Map(); // file -> Leaflet rectangle

$("app-version").textContent = self.T_GRAZE_VERSION ?? "";

// The phone app beside the map (for showing it on a call): the same app, same farm, same sign-in.
const PHONE_KEY = "t_graze_laptop_phone";
function showPhone(on) {
  document.body.classList.toggle("with-phone", on);
  $("phone-toggle").setAttribute("aria-pressed", String(on));
  $("phone-toggle").textContent = on ? "📱 Hide phone" : "📱 Show phone";
  if (on && !$("phone-frame").src) $("phone-frame").src = "index.html";
  try { localStorage.setItem(PHONE_KEY, on ? "1" : "0"); } catch {}
  setTimeout(() => map?.invalidateSize(), 50);
}
$("phone-toggle").addEventListener("click", () => showPhone(!document.body.classList.contains("with-phone")));
$("phone-reload").addEventListener("click", () => $("phone-frame").contentWindow?.location.reload());
window.addEventListener("storage", (e) => {
  if (e.key === store.key && e.newValue) store.reload(e.newValue);
});

function toast(message, isError = false) {
  const el = $("toast");
  el.textContent = message;
  el.classList.toggle("error", isError);
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), isError ? 8000 : 4000);
}

function showStatus() {
  $("status").textContent = cloud.error ? `Sync problem: ${cloud.error}` : cloud.busy ? "Syncing…" : cloud.approved ? `Farm ${cloud.state.farmName ?? ""}` : "Not approved";
}

const when = (iso) => new Date(iso).toLocaleString("en-NZ", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const coverOf = (p) => p.cover_accepted ?? p.cover_estimate;

async function start() {
  await cloud.sync();
  showStatus();
  if (!cloud.approved) {
    $("approve").hidden = false;
    $("approve-code").textContent = cloud.displayCode ?? "…";
    setTimeout(start, 30_000);
    return;
  }
  $("approve").hidden = true;
  $("main").hidden = false;
  let phoneOn = false;
  try { phoneOn = localStorage.getItem(PHONE_KEY) === "1"; } catch {}
  showPhone(phoneOn);
  await loadPhotos();
}

async function fetchPhotos() {
  photos = await cloud.request(
    `/rest/v1/photos?select=file,taken_at,plus_code,latitude,longitude,accuracy_m,altitude_m,storage_path,paddock,cover_estimate,estimate_by,cover_accepted,accepted_at&farm_id=eq.${cloud.state.farmId}&order=taken_at.desc`);
}
// Where the map opens: the farm's saved home view, or (until one is saved) the middle of its photos.
let home = null;
async function fetchHome() {
  const [f] = await cloud.request(`/rest/v1/farms?select=map_lat,map_lng,map_zoom&id=eq.${cloud.state.farmId}`);
  home = f && f.map_lat != null && f.map_lng != null ? { center: [f.map_lat, f.map_lng], zoom: f.map_zoom ?? 16 } : null;
}
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
function goHome() {
  if (home) return map.setView(home.center, home.zoom);
  if (!photos.length) return map.setView([-37.75, 175.3], 14);
  // No home saved yet: centre on the middle photo, ignoring strays (a photo taken off the farm).
  const centres = photos.map((p) => { const { south, west, size } = decode(p.plus_code); return [south + size / 2, west + size / 2]; });
  const mid = L.latLng(median(centres.map((c) => c[0])), median(centres.map((c) => c[1])));
  const near = centres.filter((c) => mid.distanceTo(c) < 3000);
  if (near.length > 1) map.fitBounds(near, { padding: [40, 40], maxZoom: 17 });
  else map.setView(mid, 16);
}

// Where the paddocks are: one point per photo ever given a paddock (supabase/paddock-points.sql).
let points = [];
async function fetchPoints() {
  points = await cloud.request(
    `/rest/v1/paddock_points?select=photo_file,paddock,latitude,longitude&farm_id=eq.${cloud.state.farmId}`);
}
function rememberPoint(p, paddock) {
  return cloud.request("/rest/v1/paddock_points?on_conflict=farm_id,photo_file", {
    method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: { farm_id: cloud.state.farmId, photo_file: p.file, paddock, latitude: p.latitude, longitude: p.longitude, taken_at: p.taken_at },
  });
}

// First guess at a photo's paddock: the nearest earlier photos given a paddock (within GUESS_RADIUS_M),
// the closest counting most. Null if none are near enough.
const GUESS_RADIUS_M = 80;
function metresBetween(a, b) {
  const k = 111_320; // metres per degree of latitude
  const dy = (a.latitude - b.latitude) * k;
  const dx = (a.longitude - b.longitude) * k * Math.cos((a.latitude * Math.PI) / 180);
  return Math.hypot(dx, dy);
}
function guessPaddock(photo) {
  const known = new Map(points.map((q) => [q.photo_file, q]));
  for (const p of photos) if (p.paddock) known.set(p.file, { photo_file: p.file, paddock: p.paddock, latitude: p.latitude, longitude: p.longitude });
  const near = [...known.values()]
    .filter((q) => q.photo_file !== photo.file && store.paddocks.includes(q.paddock))
    .map((q) => ({ paddock: q.paddock, d: metresBetween(photo, q) }))
    .filter((q) => q.d <= GUESS_RADIUS_M)
    .sort((a, b) => a.d - b.d)
    .slice(0, 5);
  if (!near.length) return null;
  const votes = new Map();
  for (const q of near) votes.set(q.paddock, (votes.get(q.paddock) ?? 0) + 1 / (q.d + 5));
  const [paddock] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
  return { paddock, metres: Math.round(near.find((q) => q.paddock === paddock).d), others: new Set(near.map((q) => q.paddock)).size > 1 };
}

async function loadPhotos() {
  await Promise.all([fetchPhotos(), fetchHome().catch(() => (home = null)), fetchPoints().catch(() => (points = []))]);
  drawMap();
  drawList();
  checkSizes().catch((err) => console.warn("photo sizes:", err));
}

// Photos uploaded before v37 went up full size (6-7 MB). Offer to replace them with ~0.5 MB copies.
let bigPhotos = [];
async function checkSizes() {
  const farm = cloud.state.farmId;
  const items = await cloud.request("/storage/v1/object/list/photos", {
    method: "POST", body: { prefix: farm, limit: 1000, offset: 0 },
  });
  bigPhotos = items.filter((o) => (o.metadata?.size ?? 0) > UPLOAD_BIG_BYTES)
    .map((o) => ({ name: o.name, size: o.metadata.size, row: photos.find((p) => p.storage_path === `${farm}/${o.name}`) }))
    .filter((b) => b.row);
  const mb = bigPhotos.reduce((s, b) => s + b.size, 0) / 1e6;
  $("shrink").hidden = !bigPhotos.length;
  $("shrink-text").textContent = `${bigPhotos.length} photo(s) were uploaded full size (${mb.toFixed(0)} MB of the free 1 GB). `;
}
$("shrink-go").addEventListener("click", async () => {
  const btn = $("shrink-go");
  btn.disabled = true;
  const before = bigPhotos.reduce((s, b) => s + b.size, 0);
  let after = 0;
  let done = 0;
  try {
    const signed = await cloud.request("/storage/v1/object/sign/photos", {
      method: "POST", body: { expiresIn: 3600, paths: bigPhotos.map((b) => b.row.storage_path) },
    });
    for (const b of bigPhotos) {
      $("shrink-text").textContent = `Shrinking ${done + 1} of ${bigPhotos.length}…`;
      const link = signed.find((s) => s.path === b.row.storage_path)?.signedURL;
      if (!link) throw new Error(`no link for ${b.row.file}`);
      const res = await fetch(`${SUPABASE_URL}/storage/v1${link}`);
      if (!res.ok) throw new Error(`download ${b.row.file}: ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const tilt = tiltFromJpeg(bytes);
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }), { imageOrientation: "from-image" });
      const small = await uploadCopy(bitmap, {
        lat: b.row.latitude, lng: b.row.longitude, altitude: b.row.altitude_m, accuracy: b.row.accuracy_m,
        time: new Date(b.row.taken_at),
        description: b.row.file.replace(/\.jpg$/, "") + (tilt != null ? ` tilt ${tilt} deg` : ""),
      });
      bitmap.close?.();
      await cloud.request(`/storage/v1/object/photos/${b.row.storage_path.split("/").map(encodeURIComponent).join("/")}`, {
        method: "POST", raw: true, body: small, headers: { "Content-Type": "image/jpeg", "x-upsert": "true" },
      });
      after += small.size;
      done++;
    }
    toast(`Shrank ${done} photo(s): ${(before / 1e6).toFixed(0)} MB down to ${(after / 1e6).toFixed(1)} MB.`);
  } catch (err) {
    toast(`Stopped after ${done}: ${err.message}`, true);
  } finally {
    btn.disabled = false;
    await checkSizes().catch(() => {});
  }
});

function drawMap(refit = true) {
  if (!map) {
    map = L.map("map", { zoomControl: true });
    if (LINZ_BASEMAPS_KEY) {
      // LINZ aerial imagery: free for commercial use under CC BY 4.0, attribution as LINZ asks for it.
      L.tileLayer(`https://basemaps.linz.govt.nz/v1/tiles/aerial/3857/{z}/{x}/{y}.webp?api=${encodeURIComponent(LINZ_BASEMAPS_KEY)}`, {
        maxZoom: 21, maxNativeZoom: 20,
        attribution: '© <a href="https://www.linz.govt.nz/linz-copyright" target="_blank" rel="noopener">LINZ CC BY 4.0</a> © <a href="https://www.linz.govt.nz/data/linz-data/linz-basemaps/data-attribution" target="_blank" rel="noopener">Imagery Basemap contributors</a>',
      }).addTo(map);
    } else {
      L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
        maxZoom: 21, maxNativeZoom: 19,
        attribution: "Imagery © Esri, Maxar, Earthstar Geographics, and the GIS user community",
      }).addTo(map);
    }
    map.on("zoomend", layoutLabels);
    // ⌂ back to the farm's home view; 📌 save what's on screen as everyone's home view for this farm.
    const Ctl = L.Control.extend({
      onAdd() {
        const box = L.DomUtil.create("div", "leaflet-bar home-ctl");
        const btn = (text, title, fn) => {
          const a = L.DomUtil.create("a", "", box);
          a.href = "#"; a.textContent = text; a.title = title; a.setAttribute("role", "button"); a.setAttribute("aria-label", title);
          L.DomEvent.on(a, "click", (e) => { L.DomEvent.preventDefault(e); L.DomEvent.stopPropagation(e); fn(); });
        };
        btn("⌂", "Back to the farm's home view", goHome);
        btn("📌", "Save this view as the farm's home view (for everyone on the farm)", saveHome);
        return box;
      },
    });
    new Ctl({ position: "topleft" }).addTo(map);
  }
  map.invalidateSize(); // the map was hidden until now
  for (const r of squares.values()) r.remove();
  squares.clear();
  const bounds = [];
  for (const p of photos) {
    const { south, west, size } = decode(p.plus_code);
    const box = [[south, west], [south + size, west + size]];
    bounds.push(...box);
    const ok = p.cover_accepted != null;
    const rect = L.rectangle(box, {
      color: ok ? "#6ee7a0" : coverOf(p) != null ? "#ffd23f" : "#ffffff",
      weight: 2, fillOpacity: 0.25,
    }).addTo(map);
    const label = coverOf(p) == null ? "?" : `${ok ? `${p.paddock} ` : ""}${coverOf(p)}${ok ? " ✓" : "?"}`;
    rect.bindTooltip(label, { permanent: true, direction: "right", offset: [6, 0], className: `cov${ok ? " ok" : ""}` });
    rect.on("click", () => choose(p.file));
    rect.baseStyle = { color: rect.options.color, weight: 2, fillOpacity: 0.25 };
    squares.set(p.file, rect);
  }
  markChosen();
  if (refit) goHome();
  requestAnimationFrame(layoutLabels);
}

async function saveHome() {
  const c = map.getCenter();
  const view = { map_lat: Number(c.lat.toFixed(7)), map_lng: Number(c.lng.toFixed(7)), map_zoom: map.getZoom() };
  try {
    await cloud.request(`/rest/v1/farms?id=eq.${cloud.state.farmId}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: view });
    home = { center: [view.map_lat, view.map_lng], zoom: view.map_zoom };
    toast("Saved: the map now opens here for everyone on the farm.");
  } catch (err) {
    toast(`Not saved: ${err.message}`, true);
  }
}

// Photos a few metres apart have squares side by side, and their labels would run into each other.
// Place each label to the right of its square; if that hits a label already placed, try the left,
// then a line above or below, and so on. Redone after every zoom (the squares change size).
function layoutLabels() {
  if (!map) return;
  const placed = [];
  const overlap = (b, p) => b.x < p.x + p.w + 2 && p.x < b.x + b.w + 2 && b.y < p.y + p.h + 1 && p.y < b.y + b.h + 1;
  // Squares are in the way too: a label sitting on the next square reads as that square's.
  const screenBox = (r) => {
    const a = map.latLngToContainerPoint(r.getBounds().getNorthWest());
    const b = map.latLngToContainerPoint(r.getBounds().getSouthEast());
    return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y, rect: r };
  };
  const squareBoxes = [...squares.values()].map(screenBox);
  const rects = [...squares.values()].sort((a, b) => b.getBounds().getNorth() - a.getBounds().getNorth());
  for (const rect of rects) {
    const tip = rect.getTooltip();
    const el = tip?.getElement();
    if (!el) continue;
    const c = map.latLngToContainerPoint(rect.getBounds().getCenter());
    const half = (map.latLngToContainerPoint(rect.getBounds().getNorthEast()).x - map.latLngToContainerPoint(rect.getBounds().getSouthWest()).x) / 2;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const gap = Math.max(6, half + 4);
    const box = (dir, dy) => ({ x: dir === "right" ? c.x + gap : c.x - gap - w, y: c.y + dy - h / 2, w, h, dir, dy });
    const tries = [];
    for (const k of [0, -1, 1, -2, 2, -3, 3]) for (const dir of ["right", "left"]) tries.push(box(dir, k * (h + 2)));
    const free = (b) => !placed.some((p) => overlap(b, p)) && !squareBoxes.some((s) => s.rect !== rect && overlap(b, s));
    const pick = tries.find(free) ?? tries.find((b) => !placed.some((p) => overlap(b, p))) ?? tries[0];
    placed.push(pick);
    tip.options.direction = pick.dir;
    tip.options.offset = L.point(pick.dir === "right" ? gap : -gap, pick.dy);
    tip.update();
  }
}

// The photo open in the panel: its square gets a thick white outline and its label stands out,
// and its row in the list is shaded.
function markChosen() {
  for (const [file, rect] of squares) {
    const on = chosen?.file === file;
    rect.setStyle(on ? { color: "#ffffff", weight: 5, fillOpacity: 0.45 } : rect.baseStyle);
    rect.getTooltip()?.getElement()?.classList.toggle("chosen", on);
    if (on) rect.bringToFront();
  }
  for (const li of $("photo-list").children) li.classList.toggle("chosen", li.dataset.file === chosen?.file);
  requestAnimationFrame(layoutLabels); // the chosen label is bigger
}

function drawList() {
  const items = photos.map((p) => {
    const li = document.createElement("li");
    li.dataset.file = p.file;
    const name = document.createElement("span");
    name.textContent = `${when(p.taken_at)} · ${p.plus_code.slice(4)}${p.paddock ? ` · ${p.paddock}` : ""}`;
    const c = document.createElement("span");
    c.className = `c${p.cover_accepted != null ? " ok" : ""}`;
    c.textContent = coverOf(p) == null ? "–" : `${coverOf(p)}${p.cover_accepted != null ? " ✓" : "?"}`;
    li.append(name, c);
    return li;
  });
  $("photo-list").replaceChildren(...items);
  const waiting = photos.filter((p) => coverOf(p) == null).length;
  $("waiting-count").hidden = !waiting;
  $("waiting-count").textContent = waiting === 1 ? "1 new photo is waiting for a cover estimate."
    : `${waiting} new photos are waiting for a cover estimate.`;
  markChosen();
}
$("photo-list").addEventListener("click", (e) => {
  const li = e.target.closest("li[data-file]");
  if (li) choose(li.dataset.file);
});

async function choose(file) {
  chosen = photos.find((p) => p.file === file);
  if (!chosen) return;
  $("pick-none").hidden = true;
  $("pick").hidden = false;
  $("pick-title").textContent = chosen.plus_code.slice(4);
  $("pick-sub").textContent = `${when(chosen.taken_at)} · ±${Math.round(chosen.accuracy_m ?? 0)} m`;
  // A typing box with suggestions: "D" lists only the D paddocks (a dropdown jumps to D01 at the bottom).
  $("paddock-names").replaceChildren(...store.paddocks.map((n) => new Option(n)));
  const guess = chosen.paddock ? null : guessPaddock(chosen);
  $("pick-paddock").value = chosen.paddock ?? guess?.paddock ?? "";
  $("pick-guess").hidden = !guess;
  if (guess) {
    $("pick-guess").textContent = `Guessed from nearby photos: the closest ${guess.paddock} photo is ${guess.metres} m away` +
      (guess.others ? " (another paddock is close too, so check the fence line)." : ".");
  }
  $("pick-cover").value = coverOf(chosen) ?? "";
  $("pick-est").textContent = chosen.cover_estimate == null ? "No estimate yet: type the cover."
    : `Estimated ${chosen.cover_estimate} (${chosen.estimate_by ?? "estimate"}).`;
  const sameDay = chosen.paddock ? photoDayCover(photos, chosen.paddock, isoDate(new Date(chosen.taken_at))) : null;
  $("pick-note").textContent = chosen.cover_accepted != null
    ? `Accepted ${chosen.cover_accepted} for ${chosen.paddock} on ${when(chosen.accepted_at)}.` +
      (sameDay?.count > 1 ? ` With the other ${sameDay.count - 1} photo(s) of ${chosen.paddock} that day, its reading is the average: ${sameDay.cover}.` : "") +
      " Accepting again replaces it."
    : "Photos of the same paddock on the same day are averaged into one reading.";
  const sq = squares.get(file);
  if (sq) map.panTo(sq.getBounds().getCenter());
  markChosen();
  const img = $("pick-img");
  img.removeAttribute("src");
  try {
    // Ask for the link with the file name in the body, not the address: names contain "+" (from the
    // plus code), which got signed as "%2B" and then failed the check ("InvalidSignature").
    const [{ signedURL, error } = {}] = await cloud.request("/storage/v1/object/sign/photos", {
      method: "POST", body: { expiresIn: 3600, paths: [chosen.storage_path] },
    });
    if (!signedURL) throw new Error(error || "no link returned");
    if (chosen?.file !== file) return;
    img.src = `${SUPABASE_URL}/storage/v1${signedURL}`;
    $("pick-link").href = img.src;
  } catch (err) {
    toast(`Couldn't load the photo: ${err.message}`, true);
  }
}
$("pick-delete").addEventListener("click", async () => {
  if (!chosen) return;
  const file = chosen.file;
  if (!confirm(`Delete ${file} from the farm's database?\n\nAny cover already accepted from it stays. This can't be undone (the phone that took it may still have the full-size copy).`)) return;
  try {
    // Straight away (not queued): the picture, then the row. A missing picture is fine.
    await cloud.request("/storage/v1/object/photos", { method: "DELETE", body: { prefixes: [chosen.storage_path] } });
    await cloud.request(`/rest/v1/photos?farm_id=eq.${cloud.state.farmId}&file=eq.${encodeURIComponent(file)}`, {
      method: "DELETE", headers: { Prefer: "return=minimal" },
    });
    store.removePhoto(file);
    toast(`Deleted ${file}`);
    chosen = null;
    $("pick").hidden = true;
    $("pick-none").hidden = false;
    await loadPhotos();
  } catch (err) {
    toast(`Not deleted: ${err.message}`, true);
  }
});

$("pick-close").addEventListener("click", () => {
  chosen = null;
  markChosen();
  $("pick").hidden = true;
  $("pick-none").hidden = false;
});

// Clicking into the paddock box selects the guess, so typing replaces it.
$("pick-paddock").addEventListener("focus", (e) => e.target.select());

$("pick-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!chosen) return;
  const typed = $("pick-paddock").value.trim();
  const paddock = store.paddocks.find((n) => n.toLowerCase() === typed.toLowerCase());
  if (!paddock) {
    toast(`"${typed}" isn't one of the farm's paddocks. Type its name, e.g. D01, and pick it from the list.`, true);
    $("pick-paddock").focus();
    return;
  }
  const cover = Math.round(Number($("pick-cover").value));
  const taken = new Date(chosen.taken_at);
  const day = isoDate(taken);
  const file = chosen.file;
  const before = chosen.paddock && chosen.cover_accepted != null ? chosen.paddock : null;
  try {
    const accepted_at = new Date().toISOString();
    await cloud.request(`/rest/v1/photos?farm_id=eq.${cloud.state.farmId}&file=eq.${encodeURIComponent(file)}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: { paddock, cover_accepted: cover, accepted_at },
    });
    await rememberPoint(chosen, paddock).catch((err) => console.warn("paddock point:", err));
    await Promise.all([fetchPhotos(), fetchPoints().catch(() => {})]); // fresh, so the other laptop's count too
    // One cover reading per paddock per day: the average of every photo accepted for it that day.
    // Same path as a cover typed on a phone, but method "photo" and the photos' own day.
    const saveDay = (name) => {
      const avg = photoDayCover(photos, name, day);
      if (avg) cloud.coverMeasured(measureCover(store, name, avg.cover, taken, "photo"));
      return avg;
    };
    const avg = saveDay(paddock);
    let moved = "";
    if (before && before !== paddock) {
      const left = saveDay(before);
      moved = left
        ? ` ${before} is now ${left.cover} from ${left.count} photo(s).`
        : ` ${before} keeps its earlier reading for that day: re-measure it if that's wrong.`;
    }
    await cloud.sync();
    toast(avg.count > 1
      ? `${paddock} on ${day}: average of ${avg.count} photos = ${avg.cover}.${moved}`
      : `${paddock}: ${avg.cover} on ${day} saved (photo).${moved}`);
    drawMap(false);
    drawList();
    choose(file);
  } catch (err) {
    toast(`Not saved: ${err.message}`, true);
  }
});

start();
