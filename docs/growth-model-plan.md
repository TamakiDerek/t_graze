# Cover growth model: plan for later

Not built yet. This is the agreed direction so the next steps fit what's already there.

## Where it stands

`estimateCover()` in `app/model.js` starts at 1500 kg DM/ha the day after grazing and adds one day of
growth at a time. Each day's growth comes from `GROWTH_CURVE`: kg DM/ha/day by current cover, with
straight lines between the points. Because it already steps a day at a time, every addition below is a
multiplier on that day's growth.

## The shape to aim for

```text
growth(day) = curve(cover) × light(day) × warmth(day) × moisture(day) × farm_factor
```

Each factor is 0–1 (farm_factor can go above 1). 1 means "no limit".

| Factor | Why | Likely source |
|--------|-----|---------------|
| `curve(cover)` | Regrowth is slow just after grazing and slows again as the sward closes up | Derek's trial table (cover → growth), replacing `GROWTH_CURVE` |
| `light` | Short, dull winter days | Daily solar radiation (MJ/m²) at the farm |
| `warmth` | Little growth below about 5 °C soil or air temperature; slowdown in heat | Daily mean air or 10 cm soil temperature |
| `moisture` | Soil moisture deficit (SMD) in summer dry spells | Daily SMD, or rain minus evapotranspiration run through a simple water balance |
| `farm_factor` | Corrects all of the above to what the paddocks actually do | Verified cover readings (below) |

Keep each factor as a small table with straight lines between points, the same as `GROWTH_CURVE`, so Derek
can tune it by giving numbers rather than formulas. For example, warmth: 0 °C → 0, 5 °C → 0.2,
10 °C → 0.7, 14–22 °C → 1, 28 °C → 0.6.

## Weather data (public)

- **Open-Meteo** (open-meteo.com): free, no key, JSON by latitude and longitude. It has daily history and
  forecasts of temperature, soil temperature, shortwave radiation, rain, ET₀ evapotranspiration and soil
  moisture. This is the easiest start. Check its licence terms if the app becomes commercial.
- **NIWA**: the New Zealand authority. Its Virtual Climate Station Network has daily SMD on a 5 km grid,
  and NIWA publishes national SMD and drought maps. Full data access may need a licence or a fee.
- **MetService / NIWA forecasts**: for projecting covers forward, not just estimating today.

Plan: fetch one farm-location weather series a day, store it in a Supabase table (`weather_daily`: farm_id,
day, temp, soil_temp, radiation, rain, et0, smd), and have the phones download it with the rest of the sync.
The estimate stays offline-capable.

## Verified readings override and calibrate

1. **The paddock itself**: a measured cover resets that paddock's estimate. Grow forward from the
   measurement and its date, not from the grazing date. `estimateCover` needs a start cover and a start date
   instead of just "days since grazed".
2. **The rest of the farm**: compare each new measurement with what the model predicted for that paddock
   that day. The ratio (actual growth ÷ predicted growth since the last anchor) feeds `farm_factor`.
   Use a rolling average of recent ratios, weighted toward the newest. This gives "if one paddock is growing
   really well, the others probably are."
3. Done (2026-11-23): every measurement entered with ✏️ is stored in `cover_readings` next to the app's
   `predicted` cover, `days_since_grazed` and `model` id (`COVER_MODEL` in `app/model.js`; change it whenever
   the estimate rule changes). Those pairs are the data for refitting the factors.

## Code changes this will need

- `estimateCover(start, startDate, today, factorsFor)`: loop over actual dates so each day's factors
  can be looked up.
- A `covers` history table (paddock, date, value, method, predicted), not just the latest value on
  `paddocks`.
- A cover-entry screen on the phone (the `v` readings).
- Unit tests for each factor table and for the calibration ratio.
