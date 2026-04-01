import { prisma } from "@/app/lib/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RequestBody = {
  token?: string;
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as RequestBody;
    const token = body.token?.trim();

    if (!token) {
      return Response.json({ error: "token is required" }, { status: 400 });
    }

    const now = new Date();
    const invite = await prisma.interview_invites.findUnique({
      where: {
        token,
      },
      select: {
        invite_id: true,
        interview_id: true,
        status: true,
        expires_at: true,
        max_attempts: true,
        attempts_used: true,
      },
    });

    if (!invite) {
      return Response.json({ error: "Invite not found" }, { status: 404 });
    }

    if (invite.status && invite.status !== "ACTIVE") {
      return Response.json({ error: "Invite is not active" }, { status: 400 });
    }

    if (invite.expires_at && invite.expires_at <= now) {
      return Response.json({ error: "Invite has expired" }, { status: 400 });
    }

    const latestAttempt = await prisma.interview_attempts.findFirst({
      where: {
        interview_id: invite.interview_id,
      },
      orderBy: [
        {
          attempt_number: "desc",
        },
        {
          started_at: "desc",
        },
      ],
      select: {
        attempt_id: true,
        attempt_number: true,
        status: true,
      },
    });

    if (latestAttempt && latestAttempt.status === "STARTED") {
      return Response.json({
        attemptId: latestAttempt.attempt_id,
        interviewId: invite.interview_id,
        reused: true,
      });
    }

    const attemptsUsed = invite.attempts_used ?? 0;
    const maxAttempts = invite.max_attempts ?? 1;

    if (attemptsUsed >= maxAttempts) {
      return Response.json(
        { error: "Maximum attempts reached for this invite" },
        { status: 400 }
      );
    }

    const nextAttemptNumber = (latestAttempt?.attempt_number ?? 0) + 1;

    const [attempt] = await prisma.$transaction([
      prisma.interview_attempts.create({
        data: {
          interview_id: invite.interview_id,
          attempt_number: nextAttemptNumber,
          status: "STARTED",
        },
        select: {
          attempt_id: true,
          interview_id: true,
          attempt_number: true,
        },
      }),
      prisma.interview_invites.update({
        where: {
          invite_id: invite.invite_id,
        },
        data: {
          attempts_used: {
            increment: 1,
          },
          used_at: now,
        },
        select: {
          invite_id: true,
        },
      }),
    ]);

    return Response.json({
      attemptId: attempt.attempt_id,
      interviewId: attempt.interview_id,
      attemptNumber: attempt.attempt_number,
      reused: false,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to start interview session";

    return Response.json({ error: message }, { status: 500 });
  }
}
