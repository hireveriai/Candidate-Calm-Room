import {
  AudioCodec,
  EgressStatus,
  EgressClient,
  EncodedFileOutput,
  EncodedFileType,
  EncodingOptions,
  S3Upload,
  VideoCodec,
} from "livekit-server-sdk";
import { buildCandidateRecordingFilePath } from "@/app/lib/livekit/recordingFileNames";

export type RecordingStartResult = {
  egressId: string;
  filePath: string;
  videoUrl: string;
};

function requireEnv(name: string) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} is not configured`);
  }

  return value;
}

function requireAnyEnv(names: string[]) {
  for (const name of names) {
    const value = process.env[name]?.trim();

    if (value) {
      return value;
    }
  }

  throw new Error(`${names.join(" or ")} is not configured`);
}

function getOptionalEnv(name: string) {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function getOptionalAnyEnv(names: string[]) {
  for (const name of names) {
    const value = getOptionalEnv(name);

    if (value) {
      return value;
    }
  }

  return null;
}

function getBooleanAnyEnv(names: string[], fallback = false) {
  const value = getOptionalAnyEnv(names);

  if (!value) {
    return fallback;
  }

  return value.toLowerCase() === "true";
}

function getPositiveIntegerEnv(name: string, fallback: number) {
  const value = Number.parseInt(process.env[name]?.trim() ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function clampInteger(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(Math.round(value), minimum), maximum);
}

function normalizeLiveKitHost(url: string) {
  if (url.startsWith("wss://")) {
    return `https://${url.slice("wss://".length)}`;
  }

  if (url.startsWith("ws://")) {
    return `http://${url.slice("ws://".length)}`;
  }

  return url;
}

function normalizeHttpUrl(url: string) {
  if (/^https?:\/\//i.test(url)) {
    return url.replace(/\/+$/, "");
  }

  return `https://${url.replace(/\/+$/, "")}`;
}

function buildSupabasePublicBaseUrl(endpoint: string, bucket: string) {
  const endpointUrl = new URL(endpoint);

  if (!endpointUrl.hostname.endsWith(".storage.supabase.co")) {
    return null;
  }

  const projectHost = endpointUrl.hostname.replace(
    ".storage.supabase.co",
    ".supabase.co",
  );

  return `${endpointUrl.protocol}//${projectHost}/storage/v1/object/public/${bucket}`;
}

function getEgressClient() {
  return new EgressClient(
    normalizeLiveKitHost(requireEnv("LIVEKIT_URL")),
    requireEnv("LIVEKIT_API_KEY"),
    requireEnv("LIVEKIT_API_SECRET"),
  );
}

export function buildRecordingFilePath(
  roomName: string,
  at = new Date(),
  candidateName?: string | null,
) {
  return buildCandidateRecordingFilePath({
    candidateName,
    attemptId: roomName,
    source: "livekit",
    extension: "mp4",
    at,
  });
}

function buildS3UploadConfig() {
  const endpoint = normalizeHttpUrl(
    requireAnyEnv([
      "RECORDING_S3_ENDPOINT",
      "SUPABASE_STORAGE_S3_ENDPOINT",
    ]),
  );

  return new S3Upload({
    accessKey: requireAnyEnv([
      "RECORDING_S3_ACCESS_KEY",
      "SUPABASE_STORAGE_S3_ACCESS_KEY_ID",
    ]),
    secret: requireAnyEnv([
      "RECORDING_S3_SECRET_KEY",
      "SUPABASE_STORAGE_S3_SECRET_ACCESS_KEY",
    ]),
    sessionToken:
      getOptionalAnyEnv([
        "RECORDING_S3_SESSION_TOKEN",
        "SUPABASE_STORAGE_S3_SESSION_TOKEN",
      ]) ?? "",
    region: requireAnyEnv([
      "RECORDING_S3_REGION",
      "SUPABASE_STORAGE_S3_REGION",
    ]),
    endpoint,
    bucket: requireAnyEnv([
      "RECORDING_S3_BUCKET",
      "SUPABASE_STORAGE_BUCKET",
    ]),
    forcePathStyle: getBooleanAnyEnv(
      [
        "RECORDING_S3_FORCE_PATH_STYLE",
        "SUPABASE_STORAGE_S3_FORCE_PATH_STYLE",
      ],
      endpoint.includes("/storage/v1/s3"),
    ),
    metadata: {},
    tagging: "",
    contentDisposition: "inline",
  });
}

function buildRecordingVideoUrl(filePath: string) {
  const publicBaseUrl = getOptionalAnyEnv([
    "RECORDING_S3_PUBLIC_BASE_URL",
    "SUPABASE_STORAGE_PUBLIC_BASE_URL",
  ]);
  if (publicBaseUrl) {
    return `${normalizeHttpUrl(publicBaseUrl)}/${filePath}`;
  }

  const bucket = requireAnyEnv([
    "RECORDING_S3_BUCKET",
    "SUPABASE_STORAGE_BUCKET",
  ]);

  const endpoint = normalizeHttpUrl(
    requireAnyEnv([
      "RECORDING_S3_ENDPOINT",
      "SUPABASE_STORAGE_S3_ENDPOINT",
    ]),
  );
  const supabasePublicBaseUrl = buildSupabasePublicBaseUrl(endpoint, bucket);

  if (supabasePublicBaseUrl) {
    return `${supabasePublicBaseUrl}/${filePath}`;
  }

  const supabaseUrl = getOptionalEnv("NEXT_PUBLIC_SUPABASE_URL");

  if (supabaseUrl) {
    return `${normalizeHttpUrl(
      supabaseUrl,
    )}/storage/v1/object/public/${bucket}/${filePath}`;
  }

  const forcePathStyle = getBooleanAnyEnv(
    [
      "RECORDING_S3_FORCE_PATH_STYLE",
      "SUPABASE_STORAGE_S3_FORCE_PATH_STYLE",
    ],
    endpoint.includes("/storage/v1/s3"),
  );

  if (forcePathStyle) {
    return `${endpoint}/${bucket}/${filePath}`;
  }

  const endpointUrl = new URL(endpoint);
  return `${endpointUrl.protocol}//${bucket}.${endpointUrl.host}/${filePath}`;
}

export function buildRecordingEncodingProfile(durationMinutes = 30) {
  const safeDurationMinutes = clampInteger(durationMinutes, 1, 180);
  const targetMegabytes = getPositiveIntegerEnv(
    "RECORDING_TARGET_FILE_SIZE_MB",
    40,
  );
  const targetBits = targetMegabytes * 1024 * 1024 * 8 * 0.9;
  const totalBitrateKbps = Math.floor(
    targetBits / (safeDurationMinutes * 60 * 1000),
  );
  const audioBitrate = clampInteger(totalBitrateKbps * 0.18, 24, 48);
  const videoBitrate = clampInteger(totalBitrateKbps - audioBitrate, 64, 900);

  if (videoBitrate >= 650) {
    return {
      width: 1280,
      height: 720,
      framerate: 24,
      audioBitrate,
      videoBitrate,
    };
  }

  if (videoBitrate >= 300) {
    return {
      width: 854,
      height: 480,
      framerate: 20,
      audioBitrate,
      videoBitrate,
    };
  }

  return {
    width: 640,
    height: 360,
    framerate: 15,
    audioBitrate,
    videoBitrate,
  };
}

function buildRecordingEncodingOptions(durationMinutes: number) {
  const profile = buildRecordingEncodingProfile(durationMinutes);

  return new EncodingOptions({
    width: getPositiveIntegerEnv("RECORDING_VIDEO_WIDTH", profile.width),
    height: getPositiveIntegerEnv("RECORDING_VIDEO_HEIGHT", profile.height),
    framerate: getPositiveIntegerEnv(
      "RECORDING_VIDEO_FRAMERATE",
      profile.framerate,
    ),
    audioCodec: AudioCodec.OPUS,
    audioBitrate: getPositiveIntegerEnv(
      "RECORDING_AUDIO_BITRATE_KBPS",
      profile.audioBitrate,
    ),
    audioFrequency: 48_000,
    videoCodec: VideoCodec.H264_MAIN,
    videoBitrate: getPositiveIntegerEnv(
      "RECORDING_VIDEO_BITRATE_KBPS",
      profile.videoBitrate,
    ),
    keyFrameInterval: 4,
  });
}

export async function startRecording(
  roomName: string,
  durationMinutes = 30,
  candidateName?: string | null,
): Promise<RecordingStartResult> {
  const client = getEgressClient();
  const filePath = buildRecordingFilePath(roomName, new Date(), candidateName);
  const output = new EncodedFileOutput({
    fileType: EncodedFileType.MP4,
    filepath: filePath,
    output: {
      case: "s3",
      value: buildS3UploadConfig(),
    },
  });

  const info = await client.startRoomCompositeEgress(
    roomName,
    output,
    {
      layout: "single-speaker",
      encodingOptions: buildRecordingEncodingOptions(durationMinutes),
    },
  );

  if (!info.egressId) {
    throw new Error("LiveKit did not return an egress id");
  }

  return {
    egressId: info.egressId,
    filePath,
    videoUrl: buildRecordingVideoUrl(filePath),
  };
}

export async function stopRecording(egressId: string) {
  const client = getEgressClient();
  const stopped = await client.stopEgress(egressId);

  if (
    stopped.status === EgressStatus.EGRESS_COMPLETE ||
    stopped.status === EgressStatus.EGRESS_FAILED ||
    stopped.status === EgressStatus.EGRESS_ABORTED ||
    stopped.status === EgressStatus.EGRESS_LIMIT_REACHED
  ) {
    return stopped;
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const [current] = await client.listEgress({ egressId });

    if (
      current?.status === EgressStatus.EGRESS_COMPLETE ||
      current?.status === EgressStatus.EGRESS_FAILED ||
      current?.status === EgressStatus.EGRESS_ABORTED ||
      current?.status === EgressStatus.EGRESS_LIMIT_REACHED
    ) {
      return current;
    }
  }

  return stopped;
}
