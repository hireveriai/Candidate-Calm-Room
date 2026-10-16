import { prisma } from "@/app/lib/prisma";
import { DEFAULT_CANDIDATE_DATA_RETENTION_DAYS, MEDIA_RETENTION_DAYS } from "@/app/lib/interviewConsent";
import { deleteStorageObjects, getRecordingBucket, toStorageObjectPath } from "@/app/lib/recordingStorage";

/**
 * Candidate data retention (consented to in InterviewEntryGate):
 * - media: interview recordings, live-interview recordings and identity
 *   documents are deleted MEDIA_RETENTION_DAYS after the interview;
 * - candidate data: answers, transcripts, scores and candidate details are
 *   deleted after the organization's candidate_data_retention_days
 *   (default DEFAULT_CANDIDATE_DATA_RETENTION_DAYS) by
 *   public.fn_purge_interview_candidate_data / fn_anonymize_candidate.
 *
 * Nothing is deleted unless DATA_RETENTION_ENFORCE=true. Without it the job
 * only reports what is due, so the first production runs can be reviewed.
 */
export const IDENTITY_DOCUMENT_BUCKET = "candidate-verification";
const BATCH_SIZE = 25;

export type RetentionMode = "dry_run" | "enforce";

export function getRetentionMode(env: Record<string, string | undefined> = process.env): RetentionMode {
  return env.DATA_RETENTION_ENFORCE?.trim().toLowerCase() === "true" ? "enforce" : "dry_run";
}

type DueAttempt = { attempt_id: string };
type DueRecording = { recording_id: string; file_path: string | null; audio_url: string | null; video_url: string | null };
type DueLiveRecording = { recording_id: string; storage_path: string | null };
type DueVerification = { id: string; document_urls: unknown };
type DueInterview = { interview_id: string };
type DueCandidate = { candidate_id: string };

export function documentPaths(documentUrls: unknown) {
  if (!Array.isArray(documentUrls)) {
    return [];
  }

  return documentUrls
    .map((item) => (item && typeof item === "object" && "path" in item ? toStorageObjectPath(String(item.path)) : null))
    .filter((path): path is string => Boolean(path));
}

export function recordingPaths(rows: DueRecording[]) {
  return rows
    .flatMap((row) => [row.file_path, row.audio_url, row.video_url].map(toStorageObjectPath))
    .filter((path): path is string => Boolean(path));
}

async function dueAttempts() {
  return prisma.$queryRaw<DueAttempt[]>`
    select ia.attempt_id::text
    from public.interview_attempts ia
    where ia.media_purged_at is null
      and coalesce(ia.ended_at, ia.ends_at, ia.started_at) < now() - make_interval(days => ${MEDIA_RETENTION_DAYS}::int)
    order by coalesce(ia.ended_at, ia.ends_at, ia.started_at)
    limit ${BATCH_SIZE}
  `;
}

async function dueLiveRecordings() {
  return prisma.$queryRaw<DueLiveRecording[]>`
    select recording_id::text, storage_path
    from public.live_recordings
    where storage_path is not null
      and coalesce(ended_at, started_at) < now() - make_interval(days => ${MEDIA_RETENTION_DAYS}::int)
    order by coalesce(ended_at, started_at)
    limit ${BATCH_SIZE}
  `.catch(() => [] as DueLiveRecording[]);
}

async function dueVerifications() {
  return prisma.$queryRaw<DueVerification[]>`
    select id::text, document_urls
    from public.candidate_identity_verifications
    where created_at < now() - make_interval(days => ${MEDIA_RETENTION_DAYS}::int)
      and (document_urls <> '[]'::jsonb or ocr_data <> '{}'::jsonb or encrypted_ocr_data is not null)
    order by created_at
    limit ${BATCH_SIZE}
  `;
}

async function dueInterviews() {
  return prisma.$queryRaw<DueInterview[]>`
    select i.interview_id::text
    from public.interviews i
    join public.organizations o on o.organization_id = i.organization_id
    left join lateral (
      select max(coalesce(ia.ended_at, ia.ends_at, ia.started_at)) as last_activity
      from public.interview_attempts ia
      where ia.interview_id = i.interview_id
    ) la on true
    where i.candidate_data_purged_at is null
      and coalesce(la.last_activity, i.created_at) < now() - make_interval(
        days => coalesce(o.candidate_data_retention_days, ${DEFAULT_CANDIDATE_DATA_RETENTION_DAYS}::int)
      )
    order by coalesce(la.last_activity, i.created_at)
    limit ${BATCH_SIZE}
  `;
}

// Candidates who never had an interview (e.g. screening only) but are older
// than their organization's retention period.
async function dueCandidatesWithoutInterviews() {
  return prisma.$queryRaw<DueCandidate[]>`
    select c.candidate_id::text
    from public.candidates c
    join public.organizations o on o.organization_id = c.organization_id
    where c.full_name <> 'Deleted candidate'
      and c.created_at < now() - make_interval(
        days => coalesce(o.candidate_data_retention_days, ${DEFAULT_CANDIDATE_DATA_RETENTION_DAYS}::int)
      )
      and not exists (select 1 from public.interviews i where i.candidate_id = c.candidate_id)
    order by c.created_at
    limit ${BATCH_SIZE}
  `;
}

async function purgeAttemptMedia(attemptId: string) {
  const recordings = await prisma.$queryRaw<DueRecording[]>`
    select recording_id::text, file_path, audio_url, video_url
    from public.interview_recordings
    where attempt_id = ${attemptId}::uuid
  `;
  const deleted = await deleteStorageObjects(getRecordingBucket(), recordingPaths(recordings));

  await prisma.$transaction([
    prisma.$executeRaw`
      update public.interview_recordings
      set file_path = null,
          audio_url = null,
          video_url = null,
          status = 'purged',
          expires_at = coalesce(expires_at, now())
      where attempt_id = ${attemptId}::uuid
    `,
    prisma.$executeRaw`
      update public.interview_attempts
      set media_purged_at = now()
      where attempt_id = ${attemptId}::uuid
    `,
  ]);

  return deleted;
}

async function purgeLiveRecording(row: DueLiveRecording) {
  const path = toStorageObjectPath(row.storage_path);
  const deleted = path ? await deleteStorageObjects(getRecordingBucket(), [path]) : 0;

  await prisma.$executeRaw`
    update public.live_recordings
    set storage_path = null, status = 'purged'
    where recording_id = ${row.recording_id}::uuid
  `;

  return deleted;
}

async function purgeVerificationDocuments(row: DueVerification) {
  const deleted = await deleteStorageObjects(IDENTITY_DOCUMENT_BUCKET, documentPaths(row.document_urls));

  await prisma.$executeRaw`
    update public.candidate_identity_verifications
    set document_urls = '[]'::jsonb,
        ocr_data = '{}'::jsonb,
        encrypted_ocr_data = null,
        aadhaar_last4 = null,
        full_name = null,
        dob = null,
        gender = null,
        updated_at = now()
    where id = ${row.id}::uuid
  `;

  return deleted;
}

export async function runDataRetention(mode: RetentionMode = getRetentionMode()) {
  const [attempts, liveRecordings, verifications, interviews, candidates] = await Promise.all([
    dueAttempts(),
    dueLiveRecordings(),
    dueVerifications(),
    dueInterviews(),
    dueCandidatesWithoutInterviews(),
  ]);

  const report = {
    mode,
    mediaRetentionDays: MEDIA_RETENTION_DAYS,
    defaultCandidateDataRetentionDays: DEFAULT_CANDIDATE_DATA_RETENTION_DAYS,
    batchSize: BATCH_SIZE,
    due: {
      attemptMedia: attempts.length,
      liveRecordings: liveRecordings.length,
      identityDocuments: verifications.length,
      interviews: interviews.length,
      candidatesWithoutInterviews: candidates.length,
    },
    purged: {
      attemptMedia: 0,
      liveRecordings: 0,
      identityDocuments: 0,
      interviews: 0,
      candidatesWithoutInterviews: 0,
      storageObjects: 0,
    },
    errors: [] as Array<{ kind: string; id: string; error: string }>,
  };

  if (mode !== "enforce") {
    return report;
  }

  const record = async (kind: keyof typeof report.purged, id: string, task: () => Promise<number | void>) => {
    try {
      const deletedObjects = await task();
      report.purged[kind] += 1;
      if (typeof deletedObjects === "number") {
        report.purged.storageObjects += deletedObjects;
      }
    } catch (error) {
      report.errors.push({ kind, id, error: error instanceof Error ? error.message : String(error) });
    }
  };

  for (const row of attempts) await record("attemptMedia", row.attempt_id, () => purgeAttemptMedia(row.attempt_id));
  for (const row of liveRecordings) await record("liveRecordings", row.recording_id, () => purgeLiveRecording(row));
  for (const row of verifications) await record("identityDocuments", row.id, () => purgeVerificationDocuments(row));
  for (const row of interviews) {
    await record("interviews", row.interview_id, async () => {
      await prisma.$queryRaw`select public.fn_purge_interview_candidate_data(${row.interview_id}::uuid)`;
    });
  }
  for (const row of candidates) {
    await record("candidatesWithoutInterviews", row.candidate_id, async () => {
      await prisma.$queryRaw`select public.fn_anonymize_candidate(${row.candidate_id}::uuid)`;
    });
  }

  return report;
}
