import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyMediaError,
  hasLiveAudio,
  hasLiveVideo,
  isFrameBlank,
} from "./deviceCheckPolicy";

const liveFrame = { meanLuma: 96, lumaVariance: 640 };
const blackFrame = { meanLuma: 0.4, lumaVariance: 0.2 };
const flatFrame = { meanLuma: 128, lumaVariance: 3 };

test("classifies an outright permission block", () => {
  assert.equal(
    classifyMediaError(new DOMException("Permission denied", "NotAllowedError")),
    "permission_denied"
  );
});

test("classifies the TypeError: not granted rejection as a permission block", () => {
  // Seen in production instead of a DOMException; an unmapped error here would
  // have shown a generic failure for what is really a permission problem.
  assert.equal(classifyMediaError(new TypeError("not granted")), "permission_denied");
});

test("distinguishes a busy device from a missing one", () => {
  assert.equal(
    classifyMediaError(new DOMException("Device in use", "NotReadableError")),
    "device_busy"
  );
  assert.equal(
    classifyMediaError(new DOMException("No device", "NotFoundError")),
    "no_device"
  );
});

test("treats a black frame as blank", () => {
  assert.equal(isFrameBlank(blackFrame), true);
});

test("treats a flat frame as blank even when it is bright", () => {
  // A covered lens or a stalled pipeline reads as uniform grey, not black.
  assert.equal(isFrameBlank(flatFrame), true);
});

test("accepts a frame carrying real picture data", () => {
  assert.equal(isFrameBlank(liveFrame), false);
});

test("passes the camera once enough consecutive live frames arrive", () => {
  assert.equal(hasLiveVideo(Array(4).fill(liveFrame)), true);
});

test("fails the camera that published only black frames", () => {
  // The production case: permission granted, track live, faces:0 confidence:0.
  assert.equal(hasLiveVideo(Array(12).fill(blackFrame)), false);
});

test("fails a camera that flickers but never sustains a picture", () => {
  const flickering = [liveFrame, blackFrame, liveFrame, blackFrame, liveFrame];
  assert.equal(hasLiveVideo(flickering), false);
});

test("passes the microphone on sustained speech energy", () => {
  assert.equal(hasLiveAudio(Array(8).fill(0.08)), true);
});

test("fails a muted or wrong input device that reports success", () => {
  assert.equal(hasLiveAudio(Array(40).fill(0.001)), false);
});

test("tolerates gaps between syllables", () => {
  // Speech is not continuous; requiring an unbroken run would fail slow talkers.
  const speech = [
    0.09, 0.002, 0.11, 0.001, 0.07, 0.003, 0.12, 0.001, 0.08, 0.06, 0.002, 0.09,
    0.05,
  ];
  assert.equal(speech.filter((rms) => rms >= 0.02).length, 8);
  assert.equal(hasLiveAudio(speech), true);
});
