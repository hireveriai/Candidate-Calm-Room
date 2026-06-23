import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/app/lib/prisma";
import { requireCandidateSession } from "@/app/lib/candidateSession";
import { finalizeRecordingByEgressId } from "@/app/lib/livekit/recordingLifecycle";

export const runtime = "nodejs";
export const maxDuration = 30;

type StopRecordingBody = {
  egressId?: string;
};

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

    const result = await finalizeRecordingByEgressId(egressId);

    return NextResponse.json(
      {
        success: result.completed,
        status: result.status,
        error: result.error,
      },
      { status: result.completed || result.status === "failed" ? 200 : 502 },
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
