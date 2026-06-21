import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/app/lib/prisma";
import { requireCandidateSession } from "@/app/lib/candidateSession";
import { startRecording, stopRecording } from "@/app/lib/livekit/egress";

type StartRecordingBody = {
  attemptId?: string;
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

  await prisma.$executeRaw`
    create unique index if not exists idx_interview_recordings_egress_id
      on public.interview_recordings (egress_id)
      where egress_id is not null
  `;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as StartRecordingBody;
    const attemptId = body.attemptId?.trim();

    if (!attemptId || !uuidPattern.test(attemptId)) {
      return NextResponse.json(
        {
          skipped: true,
          reason: "invalid_attempt_id",
        },
        { status: 202 },
      );
    }
    await requireCandidateSession(request, {
      attemptId,
      operation: "livekit.start_recording",
    });

    await ensureRecordingSchema();

    const activeRows = await prisma.$queryRaw<
      Array<{ egress_id: string | null; video_url: string | null }>
    >`
      select egress_id, video_url
      from public.interview_recordings
      where attempt_id = ${attemptId}::uuid
        and status = 'recording'
        and egress_id is not null
      order by coalesce(started_at, created_at) desc
      limit 1
    `;

    const activeRecording = activeRows[0];

    if (activeRecording?.egress_id) {
      return NextResponse.json({
        egressId: activeRecording.egress_id,
        videoUrl: activeRecording.video_url,
      });
    }

    const durationRows = await prisma.$queryRaw<
      Array<{ duration_minutes: number | null }>
    >`
      select i.duration_minutes
      from public.interview_attempts ia
      join public.interviews i on i.interview_id = ia.interview_id
      where ia.attempt_id = ${attemptId}::uuid
      limit 1
    `;
    const durationMinutes = durationRows[0]?.duration_minutes ?? 30;
    const { egressId, filePath, videoUrl } = await startRecording(
      attemptId,
      durationMinutes,
    );

    try {
      await prisma.$executeRaw`
        insert into public.interview_recordings (
          attempt_id,
          room_name,
          egress_id,
          status,
          video_url,
          audio_url,
          file_path,
          started_at
        )
        values (
          ${attemptId}::uuid,
          ${attemptId},
          ${egressId},
          'recording',
          ${videoUrl},
          ${videoUrl},
          ${filePath},
          timezone('utc', now())
        )
      `;
    } catch (insertError) {
      try {
        await stopRecording(egressId);
      } catch (stopError) {
        console.error("Failed to stop orphaned recording", stopError);
      }

      throw insertError;
    }

    return NextResponse.json({ egressId, filePath, videoUrl });
  } catch (error) {
    console.error("Unable to start recording", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to start recording",
      },
      { status: 500 },
    );
  }
}
