// Open Location Code (plus code) encoding, standard 10-digit precision (~14 m x 14 m).
// Full code: "4RJX8R9C+W2". Short code (first 4 digits dropped): "8R9C+W2".
const ALPHABET = "23456789CFGHJMPQRVWX";
// Same integer grid the reference implementation uses, to avoid float rounding drift.
const LAT_PRECISION = 2.5e7; // 8000 * 3125
const LNG_PRECISION = 8.192e6; // 8000 * 1024

export function encode(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new RangeError("bad coordinates");
  let latVal = Math.round((Math.min(Math.max(lat, -90), 90) + 90) * LAT_PRECISION);
  let lngVal = Math.round((((lng + 180) % 360) + 360) % 360 * LNG_PRECISION);
  if (latVal >= 180 * LAT_PRECISION) latVal = 180 * LAT_PRECISION - 1; // north pole sits in the top cell
  let latInt = Math.floor(latVal / 3125);
  let lngInt = Math.floor(lngVal / 1024);
  let code = "";
  for (let i = 0; i < 5; i++) {
    code = ALPHABET[latInt % 20] + ALPHABET[lngInt % 20] + code;
    latInt = Math.floor(latInt / 20);
    lngInt = Math.floor(lngInt / 20);
  }
  return code.slice(0, 8) + "+" + code.slice(8);
}

export function shortCode(fullCode) {
  return fullCode.slice(4);
}

// South-west corner and size of the cell a 10-digit code names (used by the tests and the laptop side).
export function decode(fullCode) {
  const digits = fullCode.replace("+", "");
  let lat = 0;
  let lng = 0;
  let size = 20;
  for (let i = 0; i < 10; i += 2) {
    lat += ALPHABET.indexOf(digits[i]) * size;
    lng += ALPHABET.indexOf(digits[i + 1]) * size;
    size /= 20;
  }
  return { south: lat - 90, west: lng - 180, size: size * 20 };
}
