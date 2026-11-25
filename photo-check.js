// Checking the farm's photos: shared by the laptop map (laptop.js) and the phone's Check tab (app.js).
// Fetch the photos and paddock points, guess a photo's paddock, get a link to the picture, accept a
// photo's paddock and cover (which adds a "photo" cover reading), and delete a photo from the farm.
// Everything here needs signal: it talks to the farm's database straight away.
import { measureCover, isoDate, photoDayCover } from "./model.js";
import { SUPABASE_URL } from "./config.js";

const PHOTO_FIELDS = "file,taken_at,plus_code,latitude,longitude,accuracy_m,altitude_m,storage_path,paddock," +
  "cover_estimate,estimate_by,auto_estimate,auto_estimate_by,cover_accepted,accepted_at,uploaded_by";

/** The farm's photos, newest first. */
export function fetchFarmPhotos(cloud) {
  return cloud.request(`/rest/v1/photos?select=${PHOTO_FIELDS}&farm_id=eq.${cloud.state.farmId}&order=taken_at.desc`);
}

/** Where the paddocks are: one point per photo ever given a paddock (supabase/paddock-points.sql). */
export function fetchPoints(cloud) {
  return cloud.request(`/rest/v1/paddock_points?select=photo_file,paddock,latitude,longitude&farm_id=eq.${cloud.state.farmId}`);
}

export const coverOf = (p) => p.cover_accepted ?? p.cover_estimate;
/** Still to be checked: no cover accepted yet. */
export const unchecked = (p) => p.cover_accepted == null;
/** Haiku has looked at it (or it had an estimate typed in); false while it's still waiting. */
export const estimated = (p) => coverOf(p) != null || p.auto_estimate != null;

/** What the estimate says, in words, e.g. "Estimated 2300 (Claude Haiku …: dense, leafy …)." */
export function estimateText(p) {
  const said = (t) => t.replace(/\.\s*$/, ""); // Haiku's comment ends in a full stop of its own
  if (p.cover_estimate != null) return `Estimated ${p.cover_estimate} (${said(p.estimate_by ?? "estimate")}).`;
  if (p.auto_estimate_by) return `No estimate (${said(p.auto_estimate_by)}). Type the cover, or delete the photo.`;
  return "No estimate yet: type the cover.";
}

// First guess at a photo's paddock: the nearest earlier photos given a paddock (within GUESS_RADIUS_M),
// the closest counting most. Null if none are near enough.
export const GUESS_RADIUS_M = 80;
export function metresBetween(a, b) {
  const k = 111_320; // metres per degree of latitude
  const dy = (a.latitude - b.latitude) * k;
  const dx = (a.longitude - b.longitude) * k * Math.cos((a.latitude * Math.PI) / 180);
  return Math.hypot(dx, dy);
}
/** @returns {{ paddock, metres, others: boolean } | null} */
export function guessPaddock(photo, photos, points, paddocks) {
  const known = new Map(points.map((q) => [q.photo_file, q]));
  for (const p of photos) if (p.paddock) known.set(p.file, { photo_file: p.file, paddock: p.paddock, latitude: p.latitude, longitude: p.longitude });
  const near = [...known.values()]
    .filter((q) => q.photo_file !== photo.file && paddocks.includes(q.paddock))
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
export function guessText(guess) {
  return `Guessed from nearby photos: the closest ${guess.paddock} photo is ${guess.metres} m away` +
    (guess.others ? " (another paddock is close too, so check the fence line)." : ".");
}

/** A link to the picture that works for an hour. */
export async function photoLink(cloud, photo) {
  // Ask for the link with the file name in the body, not the address: names contain "+" (from the
  // plus code), which got signed as "%2B" and then failed the check ("InvalidSignature").
  const [{ signedURL, error } = {}] = await cloud.request("/storage/v1/object/sign/photos", {
    method: "POST", body: { expiresIn: 3600, paths: [photo.storage_path] },
  });
  if (!signedURL) throw new Error(error || "no link returned");
  return `${SUPABASE_URL}/storage/v1${signedURL}`;
}

/**
 * Accept a photo for a paddock with a cover: saves both against the photo, adds a paddock point, and
 * re-averages that paddock's cover reading for the photo's day (method "photo"). If the photo had been
 * accepted for another paddock, that paddock's reading for the day is redone without it.
 * Returns { photos (fresh), points (fresh), message }.
 */
export async function acceptPhoto(cloud, store, photo, paddock, cover) {
  const taken = new Date(photo.taken_at);
  const day = isoDate(taken);
  const before = photo.paddock && photo.cover_accepted != null ? photo.paddock : null;
  await cloud.request(`/rest/v1/photos?farm_id=eq.${cloud.state.farmId}&file=eq.${encodeURIComponent(photo.file)}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" },
    body: { paddock, cover_accepted: cover, accepted_at: new Date().toISOString() },
  });
  await cloud.request("/rest/v1/paddock_points?on_conflict=farm_id,photo_file", {
    method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: { farm_id: cloud.state.farmId, photo_file: photo.file, paddock, latitude: photo.latitude, longitude: photo.longitude, taken_at: photo.taken_at },
  }).catch((err) => console.warn("paddock point:", err));
  // Fresh, so photos accepted on another phone or laptop count too.
  const [photos, points] = await Promise.all([fetchFarmPhotos(cloud), fetchPoints(cloud).catch(() => [])]);
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
  const message = avg.count > 1
    ? `${paddock} on ${day}: average of ${avg.count} photos = ${avg.cover}.${moved}`
    : `${paddock}: ${avg.cover} on ${day} saved (photo).${moved}`;
  return { photos, points, message };
}

/** Deletes a photo from the farm straight away (not queued): the picture, then the row. */
export async function deleteFarmPhoto(cloud, photo) {
  await cloud.request("/storage/v1/object/photos", { method: "DELETE", body: { prefixes: [photo.storage_path] } });
  await cloud.request(`/rest/v1/photos?farm_id=eq.${cloud.state.farmId}&file=eq.${encodeURIComponent(photo.file)}`, {
    method: "DELETE", headers: { Prefer: "return=minimal" },
  });
}

/** The paddock name as the farm has it, matched without caring about capitals; null if it isn't one. */
export const findPaddock = (paddocks, typed) => paddocks.find((n) => n.toLowerCase() === typed.trim().toLowerCase()) ?? null;
