// The phone's Accept tab: go through this phone's photos that haven't been accepted yet, one at a time,
// the way the laptop map does it. Each card shows the picture, a small map of where it was taken,
// Haiku's estimate and comment, and a paddock guess; Accept saves the paddock and cover and moves on.
// Needs signal (it reads and writes the farm's database straight away); without it the tab says so.
import { LINZ_BASEMAPS_KEY } from "./config.js";
import { decode } from "./pluscode.js";
import {
  fetchFarmPhotos, fetchPoints, coverOf, unchecked, estimateText, guessPaddock, guessText, photoLink,
  acceptPhoto, deleteFarmPhoto, findPaddock,
} from "./photo-check.js";

const $ = (id) => document.getElementById(id);
const LEAFLET = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/";
const REFRESH_MS = 60_000;

let cloud, store, toast;
let photos = []; // the farm's photos, from the database
let points = [];
let queue = []; // files still to check, oldest first (the order they were taken on the walk)
let at = 0; // index into queue
let loadedAt = 0;
let map = null;
let saving = false; // an Accept or delete is under way: don't redraw the card under it
let squares = null;

export function initCheck(deps) {
  ({ cloud, store, toast } = deps);
  $("check-skip").addEventListener("click", () => step(1));
  $("check-back").addEventListener("click", () => step(-1));
  $("check-retry").addEventListener("click", () => renderCheck(true));
  $("check-paddock").addEventListener("focus", (e) => e.target.select());
  $("check-form").addEventListener("submit", accept);
  $("check-delete").addEventListener("click", remove);
}

/** How many photos are waiting to be checked, on the tab: "Check 12". Refreshed at most once a minute. */
export async function updateCheckCount(force = false) {
  if (!cloud.approved || !navigator.onLine) return;
  if (!force && Date.now() - loadedAt < REFRESH_MS) return;
  try {
    await load();
    showCount();
  } catch (err) {
    console.warn("check count:", err);
  }
}

async function load() {
  // An adviser sees their own photo space (photos from every farm they've been on), not the farm's.
  [photos, points] = await Promise.all([fetchFarmPhotos(cloud, cloud.photoFarm), cloud.adviser ? [] : fetchPoints(cloud).catch(() => [])]);
  loadedAt = Date.now();
  rebuild();
}

// Only this phone's own photos: the laptop sees and accepts everyone's.
const mine = (p) => p.uploaded_by != null && p.uploaded_by === cloud.state.session?.user_id;

// The pile to check (this phone's, not yet accepted), oldest first. Stays on the same photo if it's still there; otherwise on the one
// that slid into its place (the next one), or back to the first after the last.
function rebuild() {
  const was = queue[at];
  queue = photos.filter((p) => mine(p) && unchecked(p)).sort((a, b) => a.taken_at.localeCompare(b.taken_at)).map((p) => p.file);
  const i = queue.indexOf(was);
  at = i >= 0 ? i : at < queue.length ? at : 0;
}

function showCount() {
  const n = queue.length;
  $("check-count").textContent = n ? String(n) : "";
  $("check-count").hidden = !n;
}

function show(which) {
  for (const id of ["check-offline", "check-wait", "check-done", "check-card"]) $(id).hidden = id !== which;
}

/** Called when the tab opens (and after a sync while it's open). */
export async function renderCheck(force = false) {
  if (saving) return;
  if (!cloud.approved) {
    $("check-offline-text").textContent = "This phone isn't approved for a farm yet (see Paddocks → Sync).";
    return show("check-offline");
  }
  if (!navigator.onLine) {
    $("check-offline-text").textContent = "Checking photos needs signal. Photos you take are kept on the phone and upload when you're back in coverage.";
    return show("check-offline");
  }
  if (force || !photos.length || Date.now() - loadedAt > REFRESH_MS) {
    if (!photos.length) show("check-wait");
    try {
      await load();
    } catch (err) {
      $("check-offline-text").textContent = `Couldn't reach the farm's database (${err.message}).`;
      return show("check-offline");
    }
  }
  showCount();
  drawCard();
}

function step(by) {
  if (!queue.length) return;
  at = (at + by + queue.length) % queue.length;
  drawCard();
}

const when = (iso) => new Date(iso).toLocaleString("en-NZ", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const current = () => photos.find((p) => p.file === queue[at]);

async function drawCard() {
  const p = current();
  if (!p) {
    const own = photos.filter(mine).length;
    $("check-done-text").textContent = cloud.adviser
      ? "No photos in your adviser space yet. Take some with 📷; they show here (with Haiku's estimate) once they've uploaded."
      : own
      ? `All ${own} photos from this phone have been accepted. Photos from other phones are accepted on the laptop (or on the phone that took them).`
      : "No photos from this phone on the farm yet. Take some with 📷 on the Photos tab; they show here once they've uploaded.";
    return show("check-done");
  }
  show("check-card");
  $("check-pos").textContent = `${at + 1} of ${queue.length}`;
  $("check-back").disabled = $("check-skip").disabled = queue.length < 2;
  $("check-when").textContent = `${when(p.taken_at)} · ${p.plus_code.slice(4)} · ±${Math.round(p.accuracy_m ?? 0)} m`;
  $("check-est").textContent = estimateText(p);
  const guess = p.paddock || cloud.adviser ? null : guessPaddock(p, photos, points, store.paddocks);
  $("check-paddock").value = p.paddock ?? guess?.paddock ?? "";
  $("check-guess").hidden = !guess;
  if (guess) $("check-guess").textContent = guessText(guess);
  $("check-cover").value = coverOf(p) ?? "";
  drawMap(p);
  const img = $("check-img");
  img.removeAttribute("src");
  $("check-link").removeAttribute("href");
  try {
    const link = await photoLink(cloud, p);
    if (current()?.file !== p.file) return;
    img.src = link;
    $("check-link").href = link;
  } catch (err) {
    toast(`Couldn't load the photo: ${err.message}`, true);
  }
}

// ---------- the small map ----------
function loadLeaflet() {
  if (window.L) return Promise.resolve();
  loadLeaflet.done ??= new Promise((resolve, reject) => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = `${LEAFLET}leaflet.min.css`;
    document.head.append(css);
    const js = document.createElement("script");
    js.src = `${LEAFLET}leaflet.min.js`;
    js.onload = resolve;
    js.onerror = () => { loadLeaflet.done = null; reject(new Error("map didn't load")); };
    document.head.append(js);
  });
  return loadLeaflet.done;
}

async function drawMap(p) {
  try {
    await loadLeaflet();
  } catch {
    $("check-map").textContent = "The map needs signal.";
    return;
  }
  if (current()?.file !== p.file) return;
  if (!map) {
    map = L.map("check-map", { zoomControl: false, attributionControl: true });
    map.attributionControl.setPrefix(false);
    if (LINZ_BASEMAPS_KEY) {
      L.tileLayer(`https://basemaps.linz.govt.nz/v1/tiles/aerial/3857/{z}/{x}/{y}.webp?api=${encodeURIComponent(LINZ_BASEMAPS_KEY)}`, {
        maxZoom: 21, maxNativeZoom: 20, attribution: "© LINZ CC BY 4.0",
      }).addTo(map);
    } else {
      L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
        maxZoom: 21, maxNativeZoom: 19, attribution: "Imagery © Esri",
      }).addTo(map);
    }
    squares = L.layerGroup().addTo(map);
  }
  map.invalidateSize();
  squares.clearLayers();
  // Every farm photo as its plus-code square: green accepted (with its paddock), yellow to check, this one white.
  for (const q of photos) {
    const { south, west, size } = decode(q.plus_code);
    const me = q.file === p.file;
    const ok = q.cover_accepted != null;
    const rect = L.rectangle([[south, west], [south + size, west + size]], {
      color: me ? "#ffffff" : ok ? "#6ee7a0" : "#ffd23f", weight: me ? 4 : 2, fillOpacity: me ? 0.45 : 0.2, interactive: false,
    }).addTo(squares);
    if (ok && !me) rect.bindTooltip(q.paddock, { permanent: true, direction: "center", className: "check-tip" });
  }
  // A ring round this photo's square, so it stands out from its neighbours.
  const { south, west, size } = decode(p.plus_code);
  const centre = [south + size / 2, west + size / 2];
  L.circleMarker(centre, { radius: 16, color: "#ffffff", weight: 3, fill: false, interactive: false }).addTo(squares);
  map.setView(centre, 17);
}

// ---------- accept / delete ----------
async function accept(event) {
  event.preventDefault();
  const p = current();
  if (!p) return;
  const typed = $("check-paddock").value;
  const paddock = findPaddock(store.paddocks, typed);
  if (!paddock) {
    toast(`"${typed.trim()}" isn't one of the farm's paddocks. Type its name, e.g. D01, and pick it from the list.`, true);
    $("check-paddock").focus();
    return;
  }
  const cover = Math.round(Number($("check-cover").value));
  const btn = $("check-accept");
  btn.disabled = true;
  saving = true;
  try {
    const done = await acceptPhoto(cloud, store, p, paddock, cover);
    photos = done.photos;
    points = done.points;
    loadedAt = Date.now();
    rebuild(); // checked: off the pile; the next one slides into its place
    toast(done.message);
  } catch (err) {
    toast(`Not saved: ${err.message}`, true);
  } finally {
    btn.disabled = false;
    saving = false;
  }
  showCount();
  drawCard();
}

async function remove() {
  const p = current();
  if (!p) return;
  if (!confirm(`Delete ${p.file} from the farm?\n\nIt goes from the laptop map and every phone. Any cover already accepted from it stays. This can't be undone (the phone that took it may still have the full-size copy).`)) return;
  saving = true;
  try {
    await deleteFarmPhoto(cloud, p);
    store.removePhoto(p.file);
    photos = photos.filter((q) => q.file !== p.file);
    rebuild();
    toast(`Deleted ${p.file}`);
  } catch (err) {
    toast(`Not deleted: ${err.message}`, true);
  } finally {
    saving = false;
  }
  showCount();
  drawCard();
}
