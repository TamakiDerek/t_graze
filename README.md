# t_graze

Phone-side data capture for a dairy farm's paddock grazing rotation. It's an installable web app (PWA) for
Android Chrome and has two jobs:

- **Grazing log**: a vertical table of half-days (`Nov 17 am`, `Nov 17 pm`, newest first) with two
  paddock boxes per row. Known paddocks are suggested as you type. A name that isn't on the list asks
  *New paddock "…" - add to list?* If you say no, nothing is saved.
- **Product page** (`about.html`, https://tamakiderek.github.io/t_graze/about.html): what t_graze is, the price
  ($2 per grazed hectare a year + GST), the data policy, screenshots (`about/`) and how to sign up by email.
- **Laptop page** (`laptop.html`, e.g. https://tamakiderek.github.io/t_graze/laptop.html): an aerial map
  (LINZ aerial imagery, with `LINZ_BASEMAPS_KEY` in `app/config.js`; Esri World Imagery until a key is set) with each photo drawn as its plus-code square (about 14 × 14 m) and labelled with
  the cover estimated from it (`photos.cover_estimate`, yellow) or accepted (green, with the paddock). Click
  one to see the photo, choose the paddock and accept or change the cover: that sets `photos.paddock` /
  `cover_accepted` and adds a `cover_readings` row with method `photo` for that paddock on the photo's day. Several photos accepted for
  the same paddock on the same day are averaged into that one reading (`photoDayCover`).
  A new photo's paddock is guessed from the nearest photos already given one (within 80 m): every
  accepted photo adds a point to `paddock_points` (`supabase/paddock-points.sql`), which outlives the 3-day
  photo clean-up.
  New photos show as white squares labelled `?` with a count of how many are waiting, until they're
  estimated automatically: an after-insert trigger on `photos` (`supabase/estimate.sql`) calls the
  `estimate-cover` Edge Function (`supabase/functions/estimate-cover/`), which has Claude Haiku 5.5 compare
  the photo with the active `reference_photos` (never with itself) and writes `auto_estimate` /
  `auto_estimate_by`, and `cover_estimate` if the photo had none. References are currently farm photos
  with an accepted cover (kind `farm`, copied into the `reference` bucket with
  `{"add_farm_references": "<farm id>"}`); the DairyNZ rows are inactive. Needs the Edge Function secret
  `ANTHROPIC_API_KEY`. About 0.1 cent a photo.
  The laptop signs in and gets approved like a phone. **📱 Show phone** puts the phone app beside the map in a
  phone-sized frame (same farm and sign-in), for demonstrating it on a call; the choice is remembered. The map opens on
  the farm's home view (`farms.map_lat`/`map_lng`/`map_zoom`): ⌂ goes back to it, 📌 saves the current view as it.
- **Paddock photos**: the 📷 button stays disabled until there is a GPS fix less than a minute old.
  Each photo is saved to the phone's **Download** folder as `YYYY_MMDD_<short plus code>.jpg`
  (e.g. `2026_1117_8R9C+W2.jpg`). A second photo with the same name gets `_2`, `_3` and so on. The
  GPS position, altitude, accuracy and capture time are written into the photo's EXIF. The copy uploaded to the
  farm's database is smaller (`photo-size.js`: 1400 px on the long side, quality 0.7, about 0.5 MB); the laptop page offers to
  shrink any photo that went up full size before that. Photos are deleted from the app and the database 3 days after
  the day they were taken (`PHOTO_KEEP_DAYS`, done by whichever phone or laptop syncs); cover readings made from them
  stay. 🗑 on the phone only takes a photo off that phone's list (it still uploads if it hasn't yet); the farm's copy
  stays until the 3-day clean-up or 🗑 Delete this photo on the laptop page.
  📷 opens the app's own camera with a guide for a **standard photo**: phone at 1 m (belt height), no shadow,
  step forward so the toe is at the bottom, tilted forward about 35° from straight down (the tilt meter goes
  green at 28-42°, level side to side). The tilt is written into the EXIF description and kept with the photo.
  **Phone camera** on that screen falls back to the phone's own camera (no guide, no tilt).

The Paddocks tab is a sortable table (tap a heading; tap again to reverse): **Last grazed** (days ago),
**Cover** (kg DM/ha: an estimate tagged `e`: 1500 the day after grazing, then growing each day at a rate that depends on the cover reached, from `GROWTH_CURVE` in `app/model.js` (currently 50/day at 2000–2200, 2.5 less per 100 kg either side, minimum 15), or, once measured
after the last grazing, the measured value from `paddocks.cover`/`cover_date` grown the same way since, tagged e.g.
`m12` = measured 12 days ago; later `p12` = worked out from a photo 12 days ago. On the day a paddock is grazed it still shows the cover going in, dropping to
the residual the next day) and **Interval** (days
between the starts of the last two grazings; entries up to 3 days apart count as one grazing). The ✏️ button shows and sets the paddock's area (ha), enters a measured cover
(saved with the estimate it replaces), renames a paddock (the log follows) or removes it (only if unused). The **Analysis** tab charts every paddock with a known cover, highest first; tap a paddock's name to take it out of the
grazing rotation (e.g. for hay) or put it back: a bar from 1000 to 4000 kg DM/ha (solid = measured, pale = estimate) and the feed available,
`(cover - 1500) × ha` kg DM (never below 0), with the farm total. Below it, **Feed ahead** forecasts the average farm cover for 3 weeks, one bar per day, over the paddocks in the rotation: enter cows and
kg DM/cow/day (a farm setting shared by every phone, `farms.herd_cows`/`intake_kg`; 160 × 20 until someone changes it); each day every paddock grows on the curve, then
the herd eats from the highest paddock down to 1500 before moving on. Paddocks already in today's log are eaten first, in log order, only as far as the day's demand goes; what's left of them is finished first the next day. A day table lists the paddocks grazed and
any shortfall.

The Paddocks tab also
exports CSVs for the laptop side:

- `t_graze_log_*.csv`: `date, half, paddock_1, paddock_2`
- `t_graze_photos_*.csv`: `file, taken, plus_code, latitude, longitude, accuracy_m, altitude_m`
  (`plus_code` is the full 10-digit code, e.g. `4VJQ676H+WP`; file names use the short form)

## Sync to the farm database (Supabase)

Everything saves on the phone first: the log and paddock list in localStorage, and photos waiting to
upload in IndexedDB. Changes are queued and pushed to Supabase whenever there's signal: after each
change, every minute, and when the app comes back to the front. The header chip shows **☁ ✓**
(all uploaded), **☁ 3** (3 changes waiting) or **☁ off** (phone not approved yet).

There are no passwords. Each phone signs itself in anonymously and registers a short code, shown under
**Paddocks → Sync** (e.g. `202-82C`), where its owner also enters their name and email. To approve a
phone, run this in the Supabase SQL editor:

```sql
select public.approve_phone('202-82C', '77207');   -- farm 77207; a new name creates a new farm
select public.approve_phone('202-82C', '77207', 'Sam Smith', 'sam@example.com');   -- also set/correct the owner
```

The phone picks it up within a minute (or tap **Check now**), then uploads everything it has, including
entries made before approval. Every phone, its owner and its farm:
`select * from public.phone_list order by approved_at nulls first, registered_at desc;`

What's in Supabase (project setup is in `supabase/`: run `schema.sql`, then `phones.sql`, then `covers.sql`, then turn on
**Authentication → Sign In / Providers → Allow anonymous sign-ins**):

| Table | Holds |
|-------|-------|
| `farms`, `farm_members` | Farms (with the herd size and intake for the feed ahead) and which phones (users) belong to each |
| `devices` | Registered phones: code, owner name and email, when registered and approved |
| `paddocks` | Paddock names per farm, size (`area_ha`), whether it's `in_rotation` (false = kept for hay etc.) and latest measured cover |
| `grazing_log` | One row per farm per half-day: `day`, `half`, `paddock_1`, `paddock_2` |
| `cover_readings` | Every measured cover: `paddock`, `day`, `cover`, and what the app `predicted` for that paddock that day, grown from `start_cover` on `start_day` (`days_since_grazed`, `model`), and how it was made (`method`: `typed` or `photo`), for refitting the growth model. The newest also sets `paddocks.cover`/`cover_date` |
| `photos` | Photo metadata: `file`, `taken_at`, `plus_code` (full 10-digit), `latitude`, `longitude`, `accuracy_m`, `altitude_m`, `storage_path` |
| Storage bucket `photos` | The JPEGs (private), at `<farm_id>/<file>` |
| `reference_photos` + bucket `reference` | "For comparison" pictures of known cover (`cover`, `kind` pre/residual, `view` boot/paddock, `source`, `page`), shared by every farm; setup in `supabase/reference.sql`. The images stay private in Supabase, not in this repo (they belong to their publishers) |

Row-level security keeps each farm's rows to that farm's approved phones. An unapproved phone sees
nothing, can't approve itself and can't join a farm. Phones can't delete photo files.

If Chrome's site data for the app is cleared, the phone gets a new code and needs approving again.
Anything not yet uploaded at that point is lost, and so is the local copy of everything else, which
comes back from the database on the next sync (the last 120 days of the log).

## Layout

| Path | What |
|------|------|
| `app/` | The whole app: static files, no build step. Deploy this folder. |
| `app/model.js` | Data store, half-day slots, photo naming, CSV export (no DOM; unit tested) |
| `app/pluscode.js` | Open Location Code encode/decode |
| `app/exif.js` | Minimal JPEG EXIF writer (GPS, time, description) |
| `app/cloud.js` | Phone registration, upload queue and sync with Supabase (plain HTTP, no SDK) |
| `app/config.js` | Supabase project URL and publishable key (public by design) |
| `app/sw.js` | Service worker: works offline, refreshes from the network when there's signal |
| `supabase/` | Database setup SQL |
| `docs/growth-model-plan.md` | Plan for seasonal, moisture and calibration factors in the cover estimate |
| `tools/serve.js` | Local static server for testing |
| `test/` | `node --test` unit tests |

## Develop

```powershell
npm install
npm test
npm start
```

`npm start` serves `app/` at <http://localhost:5173>. localhost counts as secure, so GPS and the camera
work in a desktop browser. On a phone the app must be served over **HTTPS**, or Chrome won't give it GPS
or the install option. Static hosting such as GitHub Pages is enough.

When you change files in `app/`, bump the version in `app/version.js` so phones pick up the new version for
offline use.

## Install on the phone

Open the HTTPS address in Chrome, allow Location, then use **⋮ → Add to Home screen / Install app**.

## Publish

The live app is served by GitHub Pages from the `gh-pages` branch, which holds just the contents of
`app/`. After committing changes on `main` (and bumping the version in `app/version.js`):

```powershell
git push origin main
git push origin "$(git subtree split --prefix app main):refs/heads/gh-pages" --force
```
