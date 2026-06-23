import { NextRequest, NextResponse } from "next/server";

import { requireCandidateSession } from "@/app/lib/candidateSession";
import { prisma } from "@/app/lib/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type PrepareUploadBody = {
  attemptId?: string;
  mimeType?: string;
};

const allowedMimeTypes = new Map([
  ["video/webm", "webm"],
  ["video/mp4", "mp4"],
  ["video/ogg", "ogv"],
]);

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not configured`);
  }

  return value;
}

function encodeStoragePath(path: string) {
  return path
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
}

function normalizeHttpUrl(value: string) {
  return value.replace(/\/+$/, "");
}

function getPublicRecordingUrl(params: {
  supabaseUrl: string;
  bucket: string;
  filePath: string;
}) {
  const publicBase =
    process.env.RECORDING_S3_PUBLIC_BASE_URL?.trim() ||
    process.env.SUPABASE_STORAGE_PUBLIC_BASE_URL?.trim();

  if (publicBase) {
    return `${normalizeHttpUrl(publicBase)}/${params.filePath}`;
  }

  return `${params.supabaseUrl}/storage/v1/object/public/${params.bucket}/${params.filePath}`;
}

async function ensureRecordingSchema() {
  await prisma.$executeRaw`
    create extension if not exists pgcrypto
  `;

  await prisma.$executeRaw`
    create table if not exists public.interview_recordings (
      recording_id uuid primary key default gen_random_uuid(),
      attempt_id uuid,
      audio_url text,
      transcript text,
      retention_days int default 30,
      expires_at timestamptz,
      created_at timestamptz default timezone('utc', now())
    )
  `;

  await prisma.$executeRaw`
    alter table public.interview_recordings
      add column if not exists room_name text,
      add column if not exists egress_id text,
      add column if not exists status text default 'recording',
      add column if not exists video_url text,
      add column if not exists file_path text,
      add column if not exists failure_reason text,
      add column if not exists started_at timestamptz default timezone('utc', now()),
      add column if not exists ended_at timestamptz
  `;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as PrepareUploadBody;
    const attemptId = body.attemptId?.trim();
    const mimeType = body.mimeType?.split(";")[0]?.trim().toLowerCase() || "video/webm";
    const extension = allowedMimeTypes.get(mimeType);

    if (!attemptId || !uuidPattern.test(attemptId)) {
      return NextResponse.json({ error: "Valid attemptId is required" }, { status: 400 });
    }

    if (!extension) {
      return NextResponse.json({ error: "Unsupported recording format" }, { status: 400 });
    }

    await requireCandidateSession(request, {
      attemptId,
      operation: "livekit.browser_recording.prepare_upload",
    });

    await ensureRecordingSchema();

    const supabaseUrl = normalizeHttpUrl(requireEnv("NEXT_PUBLIC_SUPABASE_URL"));
    const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
    const bucket =
      process.env.RECORDING_S3_BUCKET?.trim() || requireEnv("SUPABASE_STORAGE_BUCKET");
    const filePath = `recordings/${attemptId}-browser-${new Date()
      .toISOString()
      .replace(/[.:]/g, "-")}.${extension}`;
    const videoUrl = getPublicRecordingUrl({ supabaseUrl, bucket, filePath });

    const signEndpoint = `${supabaseUrl}/storage/v1/object/upload/sign/${encodeURIComponent(
      bucket,
    )}/${encodeStoragePath(filePath)}`;
    const signResponse = await fetch(signEndpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        apikey: serviceRoleKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ upsert: true }),
      cache: "no-store",
    });
    const signed = (await signResponse.json().catch(() => null)) as
      | { url?: string; signedURL?: string; signedUrl?: string; error?: string; message?: string }
      | null;

    if (!signResponse.ok) {
      throw new Error(signed?.message ?? signed?.error ?? "Unable to sign recording upload");
    }

    const signedPath = signed?.url ?? signed?.signedURL ?? signed?.signedUrl;
    if (!signedPath) {
      throw new Error("Supabase did not return a signed upload URL");
    }

    const uploadUrl = signedPath.startsWith("http")
      ? signedPath
      : `${supabaseUrl}/storage/v1${signedPath.startsWith("/") ? "" : "/"}${signedPath}`;

    const recordingRows = await prisma.$queryRaw<Array<{ recording_id: string }>>`
      insert into public.interview_recordings (
        attempt_id,
        room_name,
        status,
        video_url,
        audio_url,
        file_path,
        started_at
      )
      values (
        ${attemptId}::uuid,
        ${attemptId},
        'uploading',
        ${videoUrl},
        ${videoUrl},
        ${filePath},
        timezone('utc', now())
      )
      returning recording_id::text
    `;

    await prisma.$executeRaw`
      update public.interview_attempts
      set recording_status = 'PENDING'
      where attempt_id = ${attemptId}::uuid
    `;

    return NextResponse.json({
      recordingId: recordingRows[0]?.recording_id,
      uploadUrl,
      filePath,
      contentType: mimeType,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Unable to prepare recording upload",
      },
      { status: 500 },
    );
  }
}
