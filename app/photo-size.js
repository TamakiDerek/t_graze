// The copy of a photo that goes up to the farm's database: about 1400 pixels on the long side and
// about 0.5 MB, instead of the phone camera's 6-7 MB. The full-size photo stays in the phone's
// Download folder. 1 GB of free storage then holds roughly 2,000 photos instead of 150.
import { insertExif } from "./exif.js";

export const UPLOAD_MAX_SIDE = 1400;
export const UPLOAD_QUALITY = 0.7;
export const UPLOAD_BIG_BYTES = 1_200_000; // anything bigger than this in storage is an old full-size upload

/**
 * Shrink an image (ImageBitmap, canvas or img) to the upload size and stamp the EXIF back on.
 * @param {{lat:number, lng:number, altitude?:number|null, accuracy?:number|null, time:Date, description?:string}} exif
 * @returns {Promise<Blob>} image/jpeg
 */
export async function uploadCopy(source, exif) {
  const w = source.width;
  const h = source.height;
  const scale = Math.min(1, UPLOAD_MAX_SIDE / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const g = canvas.getContext("2d");
  g.imageSmoothingQuality = "high";
  g.drawImage(source, 0, 0, canvas.width, canvas.height);
  const jpeg = await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("could not encode photo"))), "image/jpeg", UPLOAD_QUALITY));
  return new Blob([insertExif(new Uint8Array(await jpeg.arrayBuffer()), exif)], { type: "image/jpeg" });
}

/** The tilt our camera wrote into a photo's EXIF description ("... tilt 36 deg"), or null. */
export function tiltFromJpeg(bytes) {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 65536));
  const m = head.match(/tilt (-?\d+) deg/);
  return m ? Number(m[1]) : null;
}
