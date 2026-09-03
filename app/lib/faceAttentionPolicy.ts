export type AttentionDirection = "center" | "left" | "right" | "down";

// Deviation thresholds are expressed as a fraction of the detected face box so
// behavior stays consistent across desktop, tablet, mobile, and different camera
// resolutions.
//
// These are deliberately loose. The nose-vs-eye-center ratio is only a coarse
// proxy for head yaw: it is not roll-invariant, it inherits any constant offset
// from a camera that is not centered on the face, and TinyFaceDetector landmarks
// jitter by several pixels between samples. A tight threshold turns all three of
// those into a permanent "looking away" reading for a candidate who never moved.
const HORIZONTAL_AWAY_RATIO = 0.12;

// The vertical rule needs far more headroom than the horizontal one. On a normal
// face box (forehead to chin) the eye center sits ~40% down and the nose tip
// ~63-68% down, so verticalOffset is already ~0.23-0.28 for someone looking
// straight at the camera -- and higher still when the camera sits above the
// face, which is the usual laptop framing. Only score a downward look well
// outside that resting band.
const VERTICAL_DOWN_RATIO = 0.4;

export function classifyAttentionDirection(params: {
  faceWidth: number;
  faceHeight: number;
  noseX: number;
  noseY: number;
  eyeCenterX: number;
  eyeCenterY: number;
}): AttentionDirection {
  const faceWidth = Math.max(params.faceWidth, 1);
  const faceHeight = Math.max(params.faceHeight, 1);
  const horizontalOffset =
    (params.noseX - params.eyeCenterX) / faceWidth;
  const verticalOffset =
    (params.noseY - params.eyeCenterY) / faceHeight;

  // Horizontal direction is more reliable with the 68-point model, so evaluate
  // it before the conservative downward rule.
  if (horizontalOffset <= -HORIZONTAL_AWAY_RATIO) return "left";
  if (horizontalOffset >= HORIZONTAL_AWAY_RATIO) return "right";
  if (verticalOffset >= VERTICAL_DOWN_RATIO) return "down";
  return "center";
}

export function shouldConfirmMissingFace(consecutiveMisses: number) {
  return consecutiveMisses >= 3;
}

// Detection samples every 2s, so this is ~12s of continuous same-direction
// deviation before attention is scored as lost. Confirming after two samples
// meant a 4s window, which classifier jitter alone could satisfy.
export function shouldConfirmAttentionLoss(consecutiveAwaySamples: number) {
  return consecutiveAwaySamples >= 6;
}

// Recovery stays fast on purpose: holding a flag open longer than the evidence
// supports is the more damaging error for the candidate.
export function shouldConfirmAttentionRecovery(consecutiveCenterSamples: number) {
  return consecutiveCenterSamples >= 2;
}
