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
  candidate_name?: string | null;
};

function hasMissingFunctionError(error: unknown, functionName: string) {
  return (
    error instanceof Error &&
    error.message.includes("Raw query failed") &&
    error.message.includes(functionName) &&
    error.message.includes("does not exist")
  );
}

function hasMissingDatabaseRoutineError(error: unknown) {
  return (
    error instanceof Error &&
    error.message.includes("Raw query failed") &&
    error.message.includes("does not exist") &&
    error.message.includes("function public.")
  );
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as RequestBody;
    const token = body.token?.trim();

    if (!token) {
      return Response.json({ error: "token is required" }, { status: 400 });
    }

    let attempt: SessionStartRow | undefined;

    try {
      const rows = await prisma.$queryRaw<SessionStartRow[]>`
        select *
        from public.start_interview_session(${token}::text)
      `;

      attempt = rows[0];
    } catch (error) {
      if (
        !hasMissingFunctionError(error, "public.start_interview_session") &&
        !hasMissingDatabaseRoutineError(error)
      ) {
        throw error;
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
          interviews: {
            select: {
              candidates: {
                select: {
                  full_name: true,
                },
              },
            },
          },
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
          interview_id: true,
          attempt_number: true,
          status: true,
        },
      });

      if (latestAttempt && latestAttempt.status === "started") {
        attempt = {
          attempt_id: latestAttempt.attempt_id,
          interview_id: latestAttempt.interview_id,
          attempt_number: latestAttempt.attempt_number,
          reused: true,
          candidate_name: invite.interviews.candidates.full_name,
        };
      } else {
        const attemptsUsed = invite.attempts_used ?? 0;
        const maxAttempts = invite.max_attempts ?? 1;

        if (attemptsUsed >= maxAttempts) {
          return Response.json(
            { error: "Maximum attempts reached for this invite" },
            { status: 400 }
          );
        }

        const nextAttemptNumber = (latestAttempt?.attempt_number ?? 0) + 1;

        const [createdAttempt] = await prisma.$transaction([
          prisma.interview_attempts.create({
            data: {
              interview_id: invite.interview_id,
              attempt_number: nextAttemptNumber,
              status: "started",
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

        attempt = {
          attempt_id: createdAttempt.attempt_id,
          interview_id: createdAttempt.interview_id,
          attempt_number: createdAttempt.attempt_number,
          reused: false,
          candidate_name: invite.interviews.candidates.full_name,
        };
      }
    }

    if (!attempt) {
      return Response.json(
        { error: "Failed to start interview session" },
        { status: 500 }
      );
    }

    let candidateName = attempt.candidate_name ?? null;

    if (!candidateName) {
      const inviteWithCandidate = await prisma.interview_invites.findUnique({
        where: {
          token,
        },
        select: {
          interviews: {
            select: {
              candidates: {
                select: {
                  full_name: true,
                },
              },
            },
          },
        },
      });

      candidateName = inviteWithCandidate?.interviews.candidates.full_name ?? null;
    }

    return Response.json({
      attemptId: attempt.attempt_id,
      interviewId: attempt.interview_id,
      attemptNumber: attempt.attempt_number,
      reused: attempt.reused,
      candidateName,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to start interview session";

    return Response.json({ error: message }, { status: 500 });
  }
}
