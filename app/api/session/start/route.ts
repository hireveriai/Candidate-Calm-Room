import { prisma } from "@/app/lib/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RequestBody = {
  token?: string;
};

type SessionStartRow = {
  attempt_id: string;
  interview_id: string;
  attempt_number: number;
  reused: boolean;
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as RequestBody;
    const token = body.token?.trim();

    if (!token) {
      return Response.json({ error: "token is required" }, { status: 400 });
    }

    const rows = await prisma.$queryRaw<SessionStartRow[]>`
      select *
      from public.start_interview_session(${token})
    `;

    const attempt = rows[0];

    if (!attempt) {
      return Response.json(
        { error: "Failed to start interview session" },
        { status: 500 }
      );
    }

    return Response.json({
      attemptId: attempt.attempt_id,
      interviewId: attempt.interview_id,
      attemptNumber: attempt.attempt_number,
      reused: attempt.reused,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to start interview session";

    return Response.json({ error: message }, { status: 500 });
  }
}
