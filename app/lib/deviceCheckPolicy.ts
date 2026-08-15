/**
 * Pre-flight device verification, evaluated before an interview attempt exists.
 *
 * Two production incidents motivated this. In one, the browser denied camera
 * and microphone outright, so nothing was recorded and every answer tripped the
 * "No voice was detected" guard. In the other, permission was granted but the
 * camera published only black frames -- getUserMedia resolved, tracks reported
 * `live`, and face detection returned faces:0 confidence:0 for the whole
 * session. Both candidates burned their single attempt on a session that could
 * never have produced a usable transcript.
 *
 * So "permission granted" is not the bar. The bar is: real frames out of the
 * camera, and real acoustic energy out of the microphone.
 */

/** A blank frame is near-black... */
const MIN_MEAN_LUMA = 6;
/** ...or flat, which is how a covered lens or a stalled pipeline reads. */
const MIN_LUMA_VARIANCE = 12;
/** Frames needed before the camera is trusted (~1s at 4 samples/sec). */
const REQUIRED_LIVE_VIDEO_FRAMES = 4;

/** RMS floor separating a working mic from a muted or wrong input device. */
const MIN_VOICE_RMS = 0.02;
/** Analyser frames above the floor before the mic is trusted. */
const REQUIRED_VOICE_FRAMES = 8;

export type MediaFailureKind =
  | "permission_denied"
  | "no_device"
  | "device_busy"
  | "blank_video"
  | "silent_microphone"
  | "unsupported_browser"
  | "unknown";

export type FrameStat = {
  meanLuma: number;
  lumaVariance: number;
};

/**
 * Maps a getUserMedia rejection to something we can give the candidate a real
 * instruction for.
 *
 * `TypeError: not granted` is included deliberately: that is what one candidate's
 * browser threw instead of a DOMException, and an unmapped error there would
 * have shown a generic "something went wrong" for a permission problem.
 */
export function isMediaCaptureSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function"
  );
}

export function classifyMediaError(error: unknown): MediaFailureKind {
  const name =
    typeof error === "object" && error !== null && "name" in error
      ? String((error as { name: unknown }).name)
      : "";
  const message =
    typeof error === "object" && error !== null && "message" in error
      ? String((error as { message: unknown }).message).toLowerCase()
      : "";

  if (name === "NotAllowedError" || name === "SecurityError") {
    return "permission_denied";
  }
  if (name === "TypeError" && message.includes("not granted")) {
    return "permission_denied";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "no_device";
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return "device_busy";
  }
  if (message.includes("permission") || message.includes("not granted")) {
    return "permission_denied";
  }

  return "unknown";
}

/** True when a frame carries no usable picture -- black, or completely flat. */
export function isFrameBlank(frame: FrameStat): boolean {
  return (
    frame.meanLuma < MIN_MEAN_LUMA || frame.lumaVariance < MIN_LUMA_VARIANCE
  );
}

/**
 * The camera passes once enough consecutive frames carry real picture data.
 * Consecutive rather than cumulative, so a feed that dies after a brief flicker
 * of valid frames does not pass.
 */
export function hasLiveVideo(frames: FrameStat[]): boolean {
  let streak = 0;

  for (const frame of frames) {
    streak = isFrameBlank(frame) ? 0 : streak + 1;
    if (streak >= REQUIRED_LIVE_VIDEO_FRAMES) return true;
  }

  return false;
}

/**
 * The microphone passes once enough analyser frames clear the RMS floor. Not
 * required to be consecutive: natural speech has gaps between syllables, and
 * demanding an unbroken run would fail people who speak slowly.
 */
export function hasLiveAudio(rmsSamples: number[]): boolean {
  const active = rmsSamples.filter((rms) => rms >= MIN_VOICE_RMS).length;
  return active >= REQUIRED_VOICE_FRAMES;
}

export function describeFailure(kind: MediaFailureKind): {
  title: string;
  instruction: string;
} {
  switch (kind) {
    case "permission_denied":
      return {
        title: "Camera and microphone are blocked",
        instruction:
          "Your browser is blocking access. Click the padlock (or camera icon) in the address bar, set Camera and Microphone to Allow, then reload this page.",
      };
    case "no_device":
      return {
        title: "No camera or microphone found",
        instruction:
          "Connect a camera and microphone, or switch to a device that has both, then reload this page.",
      };
    case "device_busy":
      return {
        title: "Another app is using your camera",
        instruction:
          "Close any other app that may be holding the camera or microphone - video calls, recording tools, or another browser tab - then reload this page.",
      };
    case "blank_video":
      return {
        title: "Your camera is not sending a picture",
        instruction:
          "Access was allowed, but no image is coming through. Check that the lens cover is open and that no other app has taken over the camera, then run the check again.",
      };
    case "silent_microphone":
      return {
        title: "We cannot hear your microphone",
        instruction:
          "Access was allowed, but no sound is reaching us. Check that the correct microphone is selected in your browser and system settings and that it is not muted, then run the check again.",
      };
    case "unsupported_browser":
      return {
        title: "This browser cannot run the interview",
        instruction:
          "Open the interview link in an up-to-date Chrome, Edge, or Safari window.",
      };
    default:
      return {
        title: "We could not verify your camera and microphone",
        instruction:
          "Reload this page and run the check again. If it keeps failing, try a different browser.",
      };
  }
}

export const DEVICE_CHECK_THRESHOLDS = {
  MIN_MEAN_LUMA,
  MIN_LUMA_VARIANCE,
  REQUIRED_LIVE_VIDEO_FRAMES,
  MIN_VOICE_RMS,
  REQUIRED_VOICE_FRAMES,
} as const;
