// Laptop side: the farm's photos on an aerial map, each as its plus-code square with the cover
// estimated from it. Click one, say which paddock it is, and accept (or change) the cover: that saves
// the paddock against the photo and adds a cover reading (method "photo") for that paddock and day.
import { Store, measureCover, isoDate } from "./model.js";
import { Cloud } from "./cloud.js";
import { decode } from "./pluscode.js";
import { SUPABASE_URL } from "./config.js";

const $ = (id) => document.getElementById(id);
const store = new Store(localStorage);
const cloud = new Cloud(store, () => showStatus());
let photos = [];
let chosen = null;
let map = null;
const squares = new Map(); // file -> Leaflet rectangle

$("app-version").textContent = self.T_GRAZE_VERSION ?? "";

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
  await loadPhotos();
}

async function loadPhotos() {
  photos = await cloud.request(
    `/rest/v1/photos?select=file,taken_at,plus_code,latitude,longitude,accuracy_m,storage_path,paddock,cover_estimate,estimate_by,cover_accepted,accepted_at&farm_id=eq.${cloud.state.farmId}&order=taken_at.desc`);
  drawMap();
  drawList();
}

function drawMap(refit = true) {
  if (!map) {
    map = L.map("map", { zoomControl: true });
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 21, maxNativeZoom: 19,
      attribution: "Imagery © Esri, Maxar, Earthstar Geographics, and the GIS user community",
    }).addTo(map);
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
    squares.set(p.file, rect);
  }
  if (!refit) return;
  if (bounds.length) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 19 });
  else map.setView([-37.75, 175.3], 14);
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
  const sel = $("pick-paddock");
  sel.replaceChildren(new Option("Choose…", ""), ...store.paddocks.map((n) => new Option(n, n)));
  sel.value = chosen.paddock ?? "";
  $("pick-cover").value = coverOf(chosen) ?? "";
  $("pick-est").textContent = chosen.cover_estimate == null ? "No estimate yet: type the cover."
    : `Estimated ${chosen.cover_estimate} (${chosen.estimate_by ?? "estimate"}).`;
  $("pick-note").textContent = chosen.cover_accepted != null
    ? `Accepted ${chosen.cover_accepted} for ${chosen.paddock} on ${when(chosen.accepted_at)}. Accepting again replaces it.` : "";
  const sq = squares.get(file);
  if (sq) map.panTo(sq.getBounds().getCenter());
  const img = $("pick-img");
  img.removeAttribute("src");
  try {
    const { signedURL } = await cloud.request(`/storage/v1/object/sign/${encodeURI(`photos/${chosen.storage_path}`).replace(/\+/g, "%2B")}`, {
      method: "POST", body: { expiresIn: 3600 },
    });
    if (chosen?.file !== file) return;
    img.src = `${SUPABASE_URL}/storage/v1${signedURL}`;
    $("pick-link").href = img.src;
  } catch (err) {
    toast(`Couldn't load the photo: ${err.message}`, true);
  }
}
$("pick-close").addEventListener("click", () => {
  chosen = null;
  $("pick").hidden = true;
  $("pick-none").hidden = false;
});

$("pick-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!chosen) return;
  const paddock = $("pick-paddock").value;
  const cover = Math.round(Number($("pick-cover").value));
  const taken = new Date(chosen.taken_at);
  try {
    // Same path as a cover typed on a phone, but method "photo" and the photo's own day.
    const reading = measureCover(store, paddock, cover, taken, "photo");
    cloud.coverMeasured(reading);
    const accepted_at = new Date().toISOString();
    await cloud.request(`/rest/v1/photos?farm_id=eq.${cloud.state.farmId}&file=eq.${encodeURIComponent(chosen.file)}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: { paddock, cover_accepted: cover, accepted_at },
    });
    await cloud.sync();
    Object.assign(chosen, { paddock, cover_accepted: cover, accepted_at });
    toast(`${paddock}: ${cover} on ${isoDate(taken)} saved (photo)`);
    drawMap(false);
    drawList();
    choose(chosen.file);
  } catch (err) {
    toast(`Not saved: ${err.message}`, true);
  }
});

start();
