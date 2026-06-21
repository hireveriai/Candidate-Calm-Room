import { NextRequest, NextResponse } from "next/server";
import { EgressStatus } from "livekit-server-sdk";
import { prisma } from "@/app/lib/prisma";
import { requireCandidateSession } from "@/app/lib/candidateSession";
import { stopRecording } from "@/app/lib/livekit/egress";

export const runtime = "nodejs";
export const maxDuration = 30;

type StopRecordingBody = {
  egressId?: string;
};

function liveKitTimestampToDate(value: bigint) {
  if (value <= BigInt(0)) {
    return null;
  }

  const milliseconds = Number(value / BigInt(1_000_000));
  return Number.isFinite(milliseconds) ? new Date(milliseconds) : null;
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as StopRecordingBody;
  const egressId = body.egressId?.trim();

  if (!egressId) {
    return NextResponse.json(
      { error: "egressId is required" },
      { status: 400 },
    );
  }

  try {
    const rows = await prisma.$queryRaw<
      Array<{ status: string | null; attempt_id: string | null }>
    >`
      select status, attempt_id::text
      from public.interview_recordings
      where egress_id = ${egressId}
      limit 1
    `;

    const existingRecording = rows[0];
    if (!existingRecording?.attempt_id) {
      return NextResponse.json({ error: "Recording not found" }, { status: 404 });
    }
    await requireCandidateSession(request, {
      attemptId: existingRecording.attempt_id,
      operation: "livekit.stop_recording",
    });

    if (existingRecording?.status === "completed") {
      return NextResponse.json({ success: true, status: "completed" });
    }

    if (existingRecording?.status === "failed") {
      return NextResponse.json({ success: true, status: "failed" });
    }

    const egress = await stopRecording(egressId);
    const completed = egress.status === EgressStatus.EGRESS_COMPLETE;
    const failureReason = completed
      ? null
      : egress.error || `LiveKit egress ended with status ${egress.status}`;
    const fileResult = egress.fileResults[0];
    const mediaStartedAt =
      liveKitTimestampToDate(fileResult?.startedAt ?? BigInt(0)) ??
      liveKitTimestampToDate(egress.startedAt);
    const mediaEndedAt =
      liveKitTimestampToDate(fileResult?.endedAt ?? BigInt(0)) ??
      liveKitTimestampToDate(egress.endedAt) ??
      new Date();

    await prisma.$executeRaw`
      update public.interview_recordings
      set status = ${completed ? "completed" : "failed"},
          failure_reason = ${failureReason},
          started_at = coalesce(${mediaStartedAt}, started_at),
          ended_at = ${mediaEndedAt}
      where egress_id = ${egressId}
    `;

    await prisma.$executeRaw`
      update public.interview_attempts
      set recording_status = ${completed ? "FINALIZED" : "FAILED"}
      where attempt_id = ${existingRecording.attempt_id}::uuid
    `;

    if (!completed) {
      console.error("LiveKit recording failed", {
        egressId,
        status: egress.status,
        error: egress.error,
      });
    }

    return NextResponse.json(
      {
        success: completed,
        status: completed ? "completed" : "failed",
        error: failureReason,
      },
      { status: completed ? 200 : 502 },
    );
  } catch (error) {
    console.error("Unable to stop recording", error);

    await prisma.$executeRaw`
      update public.interview_recordings
      set status = 'failed',
          ended_at = timezone('utc', now())
      where egress_id = ${egressId}
        and ended_at is null
    `.catch((updateError: unknown) => {
      console.error("Unable to mark recording failed", updateError);
    });

    await prisma.$executeRaw`
      update public.interview_attempts ia
      set recording_status = 'FAILED'
      where ia.attempt_id = (
        select ir.attempt_id
        from public.interview_recordings ir
        where ir.egress_id = ${egressId}
        limit 1
      )
    `.catch((updateError: unknown) => {
      console.error("Unable to mark attempt recording failed", updateError);
    });

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to stop recording",
      },
      { status: 500 },
    );
  }
}
