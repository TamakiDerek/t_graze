import { test } from "node:test";
import assert from "node:assert/strict";
import exifr from "exifr";
import { insertExif } from "../app/exif.js";

// A 1x1 baseline JPEG with a JFIF APP0 segment, like a canvas produces.
const PIXEL = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
  "base64",
);

test("GPS, time and description read back with an independent EXIF reader", async () => {
  const time = new Date(2026, 10, 17, 7, 42, 9);
  const out = insertExif(PIXEL, {
    lat: -37.787654,
    lng: 175.279321,
    altitude: 52.4,
    accuracy: 6.5,
    time,
    description: "2026_1117_8R9C+W2",
  });
  assert.equal(out[0], 0xff);
  assert.equal(out[1], 0xd8);
  assert.equal(out[3], 0xe1, "APP1 straight after SOI");

  const tags = await exifr.parse(Buffer.from(out), { gps: true, tiff: true, exif: true, reviveValues: false, translateValues: false });
  assert.ok(Math.abs(tags.latitude - -37.787654) < 1e-6);
  assert.ok(Math.abs(tags.longitude - 175.279321) < 1e-6);
  assert.equal(tags.GPSLatitudeRef, "S");
  assert.equal(tags.GPSLongitudeRef, "E");
  assert.ok(Math.abs(tags.GPSAltitude - 52.4) < 0.01);
  assert.ok(Math.abs(tags.GPSHPositioningError - 6.5) < 0.01);
  assert.equal(tags.DateTimeOriginal, "2026:11:17 07:42:09");
  assert.equal(tags.ImageDescription, "2026_1117_8R9C+W2");
  assert.equal(tags.Orientation, 1);
  assert.equal(tags.Software, "t_graze");
});

test("no altitude or accuracy is fine", async () => {
  const out = insertExif(PIXEL, { lat: 51.5, lng: -0.12, altitude: null, accuracy: null, time: new Date() });
  const gps = await exifr.gps(Buffer.from(out));
  assert.ok(Math.abs(gps.latitude - 51.5) < 1e-6);
  assert.ok(Math.abs(gps.longitude - -0.12) < 1e-6);
});

test("rejects non-JPEG input", () => {
  assert.throws(() => insertExif(new Uint8Array([1, 2, 3]), { lat: 0, lng: 0, time: new Date() }), /not a JPEG/);
});
