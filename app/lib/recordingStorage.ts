const DEFAULT_SIGNED_URL_TTL_SECONDS = 60 * 60;

function requireEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not configured`);
  }

  return value;
}

function getSignedUrlTtlSeconds() {
  const configured = Number.parseInt(
    process.env.RECORDING_SIGNED_URL_TTL_SECONDS?.trim() ?? "",
    10,
  );

  if (!Number.isFinite(configured)) {
    return DEFAULT_SIGNED_URL_TTL_SECONDS;
  }

  return Math.min(Math.max(configured, 60), 24 * 60 * 60);
}

function encodeStoragePath(path: string) {
  return path
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
}

export function getRecordingBucket() {
  return process.env.RECORDING_S3_BUCKET?.trim() || requireEnv("SUPABASE_STORAGE_BUCKET");
}

/** Object path inside a bucket, from a bare path or a Supabase storage URL. */
export function toStorageObjectPath(value: string | null | undefined) {
  const raw = value?.trim() ?? "";
  if (!raw) {
    return null;
  }

  const match = raw.match(/\/object\/(?:public|sign|authenticated)\/[^/]+\/([^?]+)/);
  const path = decodeURIComponent(match?.[1] ?? raw).replace(/^\/+/, "");

  return /^https?:\/\//i.test(path) ? null : path || null;
}

/**
 * Deletes objects with the Supabase Storage bulk-remove endpoint. Missing
 * objects are not an error, so a retried purge is a no-op.
 */
export async function deleteStorageObjects(bucket: string, paths: string[]) {
  const unique = [...new Set(paths.filter(Boolean))];
  if (unique.length === 0) {
    return 0;
  }

  const supabaseUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL").replace(/\/+$/, "");
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const response = await fetch(
    `${supabaseUrl}/storage/v1/object/${encodeURIComponent(bucket)}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        apikey: serviceRoleKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ prefixes: unique }),
      cache: "no-store",
    },
  );

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { message?: string; error?: string } | null;
    throw new Error(payload?.message ?? payload?.error ?? `Storage delete failed (${response.status})`);
  }

  return unique.length;
}

export async function createRecordingSignedUrl(filePath: string) {
  const supabaseUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL").replace(/\/+$/, "");
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const bucket =
    process.env.RECORDING_S3_BUCKET?.trim() ||
    requireEnv("SUPABASE_STORAGE_BUCKET");
  const expiresIn = getSignedUrlTtlSeconds();
  const endpoint = `${supabaseUrl}/storage/v1/object/sign/${encodeURIComponent(
    bucket,
  )}/${encodeStoragePath(filePath)}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ expiresIn }),
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => null)) as
    | { signedURL?: string; signedUrl?: string; error?: string; message?: string }
    | null;

  if (!response.ok) {
    throw new Error(
      payload?.message ?? payload?.error ?? "Unable to sign recording URL",
    );
  }

  const signedPath = payload?.signedURL ?? payload?.signedUrl;
  if (!signedPath) {
    throw new Error("Supabase did not return a signed recording URL");
  }

  const relativePath = signedPath.startsWith("/object/")
    ? `/storage/v1${signedPath}`
    : signedPath;
  const url = relativePath.startsWith("http")
    ? relativePath
    : `${supabaseUrl}${relativePath.startsWith("/") ? "" : "/"}${relativePath}`;

  return {
    url,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    expiresIn,
  };
}
