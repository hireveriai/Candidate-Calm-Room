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
      noseX: 70,
      noseY: 130,
      eyeCenterX: 100,
      eyeCenterY: 80,
    }),
    "left",
  );

  assert.equal(
    classifyAttentionDirection({
      faceWidth: 200,
      faceHeight: 240,
      noseX: 130,
      noseY: 130,
      eyeCenterX: 100,
      eyeCenterY: 80,
    }),
    "right",
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

test("tolerates landmark jitter and an off-center camera", () => {
  // ~10% of face width: within the range produced by TinyFaceDetector jitter,
  // a tilted head, or a webcam mounted off to one side of the face.
  assert.equal(
    classifyAttentionDirection({
      faceWidth: 200,
      faceHeight: 240,
      noseX: 120,
      noseY: 130,
      eyeCenterX: 100,
      eyeCenterY: 80,
    }),
    "center",
  );
});

test("does not score a resting face as looking down", () => {
  // Nose tip naturally sits ~63-68% down the face box against an eye center at
  // ~40%, so a straight-ahead face already reads ~0.25 vertical offset.
  for (const noseY of [140, 150, 160]) {
    assert.equal(
      classifyAttentionDirection({
        faceWidth: 200,
        faceHeight: 240,
        noseX: 100,
        noseY,
        eyeCenterX: 100,
        eyeCenterY: 96,
      }),
      "center",
    );
  }
});

test("still scores a pronounced downward look", () => {
  assert.equal(
    classifyAttentionDirection({
      faceWidth: 200,
      faceHeight: 240,
      noseX: 100,
      noseY: 200,
      eyeCenterX: 100,
      eyeCenterY: 96,
    }),
    "down",
  );
});

test("requires sustained misses and gaze samples", () => {
  assert.equal(shouldConfirmMissingFace(1), false);
  assert.equal(shouldConfirmMissingFace(2), false);
  assert.equal(shouldConfirmMissingFace(3), true);
  // ~12s at the 2s detection interval, not 4s.
  assert.equal(shouldConfirmAttentionLoss(2), false);
  assert.equal(shouldConfirmAttentionLoss(5), false);
  assert.equal(shouldConfirmAttentionLoss(6), true);
  assert.equal(shouldConfirmAttentionRecovery(1), false);
  assert.equal(shouldConfirmAttentionRecovery(2), true);
});
