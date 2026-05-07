import {
  EgressClient,
  EncodedFileOutput,
  EncodedFileType,
  S3Upload,
} from "livekit-server-sdk";

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

export function buildRecordingFilePath(roomName: string, at = new Date()) {
  const timestamp = at.toISOString().replace(/[.:]/g, "-");
  return `recordings/${roomName}-${timestamp}.mp4`;
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

export async function startRecording(
  roomName: string,
): Promise<RecordingStartResult> {
  const client = getEgressClient();
  const filePath = buildRecordingFilePath(roomName);
  const output = new EncodedFileOutput({
    fileType: EncodedFileType.MP4,
    filepath: filePath,
    output: {
      case: "s3",
      value: buildS3UploadConfig(),
    },
  });

  const info = await client.startRoomCompositeEgress(roomName, {
    file: output,
  });

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
  await client.stopEgress(egressId);
}
