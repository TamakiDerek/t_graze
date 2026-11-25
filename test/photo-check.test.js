import { test } from "node:test";
import assert from "node:assert/strict";
import { guessPaddock, estimateText, findPaddock, unchecked } from "../app/photo-check.js";

const at = (file, dy, dx, paddock = null) => ({ file, photo_file: file, paddock, latitude: -37.7 + dy / 111_320, longitude: 175.8 + dx / 88_000 });

test("paddock guess: nearest earlier photos within 80 m, closest counting most", () => {
  const photo = at("new", 0, 0);
  const points = [at("a", 10, 0, "D04"), at("b", 30, 0, "D03"), at("c", 35, 0, "D03"), at("far", 500, 0, "B02")];
  const g = guessPaddock(photo, [photo], points, ["D03", "D04", "B02"]);
  assert.equal(g.paddock, "D04"); // 1/15 beats 1/35 + 1/40
  assert.equal(g.metres, 10);
  assert.equal(g.others, true);
  assert.equal(guessPaddock(photo, [photo], [at("far", 500, 0, "B02")], ["B02"]), null);
  // a paddock no longer on the farm (renamed) is skipped
  assert.equal(guessPaddock(photo, [photo], [at("a", 10, 0, "Old")], ["D04"]), null);
  // photos accepted since the points were fetched count too
  assert.equal(guessPaddock(photo, [photo, at("x", 5, 0, "C01")], [], ["C01"]).paddock, "C01");
});

test("estimate text, paddock matching and what's still to check", () => {
  assert.match(estimateText({ cover_estimate: 2300, estimate_by: "Claude Haiku (auto, medium confidence): leafy" }), /^Estimated 2300 \(Claude Haiku .*leafy\)\.$/);
  assert.match(estimateText({ cover_estimate: null, auto_estimate: 0, auto_estimate_by: "Claude Haiku (auto): can't judge cover: carpet" }), /^No estimate \(.*carpet\)/);
  assert.equal(estimateText({ cover_estimate: null }), "No estimate yet: type the cover.");
  assert.equal(findPaddock(["D04", "B05Mid"], " b05mid "), "B05Mid");
  assert.equal(findPaddock(["D04"], "D4"), null);
  assert.equal(unchecked({ cover_accepted: null }), true);
  assert.equal(unchecked({ cover_accepted: 2100 }), false);
});
