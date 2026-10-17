import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_RECOMMENDATION_CONFIG,
  DISPLAY_MODES,
  normalizeRecommendationConfig,
} from "../lib/recommendation-config.js";

test("empty config falls back to the shipped defaults", () => {
  assert.deepEqual(normalizeRecommendationConfig(undefined), {
    ...DEFAULT_RECOMMENDATION_CONFIG,
    styles: DEFAULT_RECOMMENDATION_CONFIG.styles.map((style) => ({ ...style })),
    selectedByCount: { 2: [0, 1], 3: [0, 1, 2], 4: [0, 1, 2, 3] },
  });
});

test("invalid enumerations and counts fall back instead of throwing", () => {
  const config = normalizeRecommendationConfig({ display: "nope", count: 9 });
  assert.equal(config.display, "ball");
  assert.equal(config.count, 3);
});

test("the retired card mode is migrated to the ball instead of silently switching off", () => {
  assert.deepEqual(DISPLAY_MODES, ["ball", "off"]);
  assert.equal(normalizeRecommendationConfig({ display: "card" }).display, "ball");
  assert.equal(normalizeRecommendationConfig({ display: "off" }).display, "off");
});

test("card-only keys are dropped from the normalized config", () => {
  const config = normalizeRecommendationConfig({ display: "ball", timing: "always", sendMode: "send" });
  assert.equal("timing" in config, false);
  assert.equal("sendMode" in config, false);
});

test("too few custom styles fall back to the shipped four directions", () => {
  const config = normalizeRecommendationConfig({ styles: [{ name: "只留一个" }] });
  assert.equal(config.styles.length, 4);
  assert.equal(config.styles[0].name, "追问/延伸");
});

test("selection lists shorter than the chosen count fall back to round-robin", () => {
  const config = normalizeRecommendationConfig({ count: 3, selectedByCount: { 3: [0, 2] } });
  assert.deepEqual(config.selectedByCount[3], [0, 1, 2]);
  assert.deepEqual(config.selectedByCount[2], [0, 1]);
});

test("out-of-range selection indices are dropped and the rest kept", () => {
  const config = normalizeRecommendationConfig({ count: 2, selectedByCount: { 2: [0, 1, 9, -1, 1] } });
  assert.deepEqual(config.selectedByCount[2], [0, 1]);
});
