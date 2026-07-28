import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyAttentionDirection,
  shouldConfirmAttentionLoss,
  shouldConfirmAttentionRecovery,
  shouldConfirmMissingFace,
} from "./faceAttentionPolicy";

test("uses face-relative geometry to detect a consistent side look", () => {
  assert.equal(
    classifyAttentionDirection({
      faceWidth: 200,
      faceHeight: 240,
      noseX: 88,
      noseY: 130,
      eyeCenterX: 100,
      eyeCenterY: 80,
    }),
    "left",
  );
});

test("keeps a centered face neutral at different resolutions", () => {
  for (const scale of [0.5, 1, 2]) {
    assert.equal(
      classifyAttentionDirection({
        faceWidth: 200 * scale,
        faceHeight: 240 * scale,
        noseX: 101 * scale,
        noseY: 130 * scale,
        eyeCenterX: 100 * scale,
        eyeCenterY: 80 * scale,
      }),
      "center",
    );
  }
});

test("requires sustained misses and gaze samples", () => {
  assert.equal(shouldConfirmMissingFace(1), false);
  assert.equal(shouldConfirmMissingFace(2), false);
  assert.equal(shouldConfirmMissingFace(3), true);
  assert.equal(shouldConfirmAttentionLoss(1), false);
  assert.equal(shouldConfirmAttentionLoss(2), true);
  assert.equal(shouldConfirmAttentionRecovery(1), false);
  assert.equal(shouldConfirmAttentionRecovery(2), true);
});
