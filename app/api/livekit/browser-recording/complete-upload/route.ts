import { NextRequest, NextResponse } from "next/server";

import { requireCandidateSession } from "@/app/lib/candidateSession";
import { prisma } from "@/app/lib/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type CompleteUploadBody = {
  attemptId?: string;
  recordingId?: string;
  filePath?: string;
  sizeBytes?: number;
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as CompleteUploadBody;
    const attemptId = body.attemptId?.trim();
    const recordingId = body.recordingId?.trim();
    const filePath = body.filePath?.trim();

    if (!attemptId || !uuidPattern.test(attemptId)) {
      return NextResponse.json({ error: "Valid attemptId is required" }, { status: 400 });
    }

    if (!recordingId || !uuidPattern.test(recordingId)) {
      return NextResponse.json({ error: "Valid recordingId is required" }, { status: 400 });
    }

    if (!filePath) {
      return NextResponse.json({ error: "filePath is required" }, { status: 400 });
    }

    await requireCandidateSession(request, {
      attemptId,
      operation: "livekit.browser_recording.complete_upload",
    });

    const bucket =
      process.env.RECORDING_S3_BUCKET?.trim() ||
      process.env.SUPABASE_STORAGE_BUCKET?.trim() ||
      "recordings";
    const objects = await prisma.$queryRaw<Array<{ id: string; size: string | number | null }>>`
      select id::text, metadata->>'size' as size
      from storage.objects
      where bucket_id = ${bucket}
        and name = ${filePath}
      limit 1
    `;

    if (!objects[0]) {
      await prisma.$executeRaw`
        update public.interview_recordings
        set status = 'failed',
            failure_reason = 'Browser recording upload did not create a Supabase object',
            ended_at = timezone('utc', now())
        where recording_id = ${recordingId}::uuid
          and attempt_id = ${attemptId}::uuid
      `;

      return NextResponse.json(
        { error: "Uploaded recording object was not found in Supabase" },
        { status: 502 },
      );
    }

    const storageSize = Number(objects[0].size ?? body.sizeBytes ?? 0);

    await prisma.$transaction([
      prisma.$executeRaw`
        update public.interview_recordings
        set status = 'completed',
            failure_reason = null,
            ended_at = timezone('utc', now())
        where recording_id = ${recordingId}::uuid
          and attempt_id = ${attemptId}::uuid
      `,
      prisma.$executeRaw`
        update public.interview_attempts
        set recording_status = 'FINALIZED'
        where attempt_id = ${attemptId}::uuid
      `,
    ]);

    return NextResponse.json({
      success: true,
      status: "completed",
      filePath,
      sizeBytes: Number.isFinite(storageSize) ? storageSize : null,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Unable to complete recording upload",
      },
      { status: 500 },
    );
  }
}
