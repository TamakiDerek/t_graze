# t_graze

Phone-side data capture for a dairy farm's paddock grazing rotation. It's an installable web app (PWA) for
Android Chrome and has two jobs:

- **Grazing log**: a vertical table of half-days (`Nov 17 am`, `Nov 17 pm`, newest first) with two
  paddock boxes per row. Known paddocks are suggested as you type. A name that isn't on the list asks
  *New paddock "…" - add to list?* If you say no, nothing is saved.
- **Paddock photos**: the 📷 button stays disabled until there is a GPS fix less than a minute old.
  Each photo is saved to the phone's **Download** folder as `YYYY_MMDD_<short plus code>.jpg`
  (e.g. `2026_1117_8R9C+W2.jpg`). A second photo with the same name gets `_2`, `_3` and so on. The
  GPS position, altitude, accuracy and capture time are written into the photo's EXIF.

The Paddocks tab lists paddocks with when each was last grazed, allows rename (the log follows) and
removal (only for unused paddocks), and exports CSVs for the laptop side:

- `t_graze_log_*.csv`: `date, half, paddock_1, paddock_2`
- `t_graze_photos_*.csv`: `file, taken, plus_code, latitude, longitude, accuracy_m, altitude_m`
  (`plus_code` is the full 10-digit code, e.g. `4VJQ676H+WP`; file names use the short form)

Data is stored in the browser's localStorage on the phone. Export regularly: clearing Chrome's site
data for the app deletes the log.

## Layout

| Path | What |
|------|------|
| `app/` | The whole app: static files, no build step. Deploy this folder. |
| `app/model.js` | Data store, half-day slots, photo naming, CSV export (no DOM; unit tested) |
| `app/pluscode.js` | Open Location Code encode/decode |
| `app/exif.js` | Minimal JPEG EXIF writer (GPS, time, description) |
| `app/sw.js` | Service worker: works offline, refreshes from the network when there's signal |
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

When you change files in `app/`, bump `CACHE` in `app/sw.js` so phones pick up the new version for
offline use.

## Install on the phone

Open the HTTPS address in Chrome, allow Location, then use **⋮ → Add to Home screen / Install app**.

## Publish

The live app is served by GitHub Pages from the `gh-pages` branch, which holds just the contents of
`app/`. After committing changes on `main` (and bumping `CACHE` in `app/sw.js`):

```powershell
git push origin main
git push origin "$(git subtree split --prefix app main):refs/heads/gh-pages" --force
```
