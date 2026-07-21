type RecordingSource = "livekit" | "browser";

export function sanitizeRecordingCandidateName(value: string | null | undefined) {
  const normalized = String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");

  return normalized || "candidate";
}

export function buildCandidateRecordingFilePath(params: {
  candidateName?: string | null;
  attemptId: string;
  source: RecordingSource;
  extension: string;
  at?: Date;
}) {
  const candidate = sanitizeRecordingCandidateName(params.candidateName);
  const timestamp = (params.at ?? new Date()).toISOString().replace(/[.:]/g, "-");
  const extension = params.extension.replace(/^\.+/, "").toLowerCase();

  return `recordings/${candidate}-${params.attemptId}-${params.source}-${timestamp}.${extension}`;
}
