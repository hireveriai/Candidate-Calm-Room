export type AttentionDirection = "center" | "left" | "right" | "down";

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

  // Ratios keep behavior consistent across desktop, tablet, mobile, and
  // different camera resolutions. Horizontal direction is more reliable with
  // the 68-point model, so evaluate it before the conservative downward rule.
  if (horizontalOffset <= -0.05) return "left";
  if (horizontalOffset >= 0.05) return "right";
  if (verticalOffset >= 0.27) return "down";
  return "center";
}

export function shouldConfirmMissingFace(consecutiveMisses: number) {
  return consecutiveMisses >= 3;
}

export function shouldConfirmAttentionLoss(consecutiveAwaySamples: number) {
  return consecutiveAwaySamples >= 2;
}

export function shouldConfirmAttentionRecovery(consecutiveCenterSamples: number) {
  return consecutiveCenterSamples >= 2;
}
