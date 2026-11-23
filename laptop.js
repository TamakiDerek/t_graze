// Laptop side: the farm's photos on an aerial map, each as its plus-code square with the cover
// estimated from it. Click one, say which paddock it is, and accept (or change) the cover: that saves
// the paddock against the photo and adds a cover reading (method "photo") for that paddock and day.
import { Store, measureCover, isoDate, photoDayCover } from "./model.js";
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
    `/rest/v1/photos?select=file,taken_at,plus_code,latitude,longitude,accuracy_m,storage_path,paddock,cover_estimate,estimate_by,cover_accepted,accepted_at&farm_id=eq.${cloud.state.farmId}&order=taken_at.desc`);
}
async function loadPhotos() {
  await fetchPhotos();
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
  // A typing box with suggestions: "D" lists only the D paddocks (a dropdown jumps to D01 at the bottom).
  $("paddock-names").replaceChildren(...store.paddocks.map((n) => new Option(n)));
  $("pick-paddock").value = chosen.paddock ?? "";
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
$("pick-close").addEventListener("click", () => {
  chosen = null;
  $("pick").hidden = true;
  $("pick-none").hidden = false;
});

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
    await fetchPhotos(); // fresh, so photos accepted on the other laptop count too
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
