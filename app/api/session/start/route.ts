import { prisma } from "@/app/lib/prisma";
import {
  isAttemptStatusFinalized,
  logInterviewEvent,
} from "@/app/lib/interviewReliability";
import { startRecoveryAttemptFromToken } from "@/app/lib/interviewRecovery";

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
  candidate_id?: string | null;
  ends_at?: Date | string | null;
};

type AttemptTimingRow = {
  attempt_id: string;
  ends_at: Date | null;
  duration_minutes: number | null;
};

type InviteAccessRow = {
  access_type: string | null;
};

type InviteAttemptRow = {
  attempt_id: string;
  interview_id: string;
  attempt_number: number;
  ends_at: Date | string | null;
  candidate_id: string | null;
  candidate_name: string | null;
};

const looseUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function looksLikeUuid(value: string | null | undefined) {
  return Boolean(value && looseUuidPattern.test(value.trim()));
}

function normalizeSessionStartRow(row: SessionStartRow | Record<string, unknown> | undefined) {
  if (!row) {
    return undefined;
  }

  const record = row as Record<string, unknown>;
  const values = Object.values(record).map((value) => String(value ?? ""));
  const uuidValues = values
    .flatMap((value) =>
      value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi) ?? []
    );
  const attemptId =
    record.attempt_id ??
    record.attemptId ??
    record.attemptid ??
    uuidValues[0] ??
    "";
  const interviewId =
    record.interview_id ??
    record.interviewId ??
    record.interviewid ??
    uuidValues[1] ??
    "";

  return {
    ...row,
    attempt_id: String(attemptId),
    interview_id: String(interviewId),
    attempt_number: Number(record.attempt_number ?? record.attemptNumber ?? 1),
    reused: Boolean(record.reused),
    candidate_name:
      typeof record.candidate_name === "string"
        ? record.candidate_name
        : typeof record.candidateName === "string"
          ? record.candidateName
          : null,
    candidate_id:
      typeof record.candidate_id === "string"
        ? record.candidate_id
        : typeof record.candidateId === "string"
          ? record.candidateId
          : null,
    ends_at: (record.ends_at ?? record.endsAt ?? null) as Date | string | null,
  } satisfies SessionStartRow;
}

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

function hasMissingDatabaseColumnError(error: unknown, columnName: string) {
  return (
    error instanceof Error &&
    error.message.toLowerCase().includes("column") &&
    error.message.toLowerCase().includes(columnName.toLowerCase()) &&
    error.message.toLowerCase().includes("does not exist")
  );
}

async function getInviteAccessType(token: string) {
  try {
    const rows = await prisma.$queryRaw<InviteAccessRow[]>`
      select access_type
      from public.interview_invites
      where token = ${token}::text
      limit 1
    `;

    return rows[0]?.access_type ?? null;
  } catch (error) {
    if (hasMissingDatabaseColumnError(error, "access_type")) {
      return null;
    }

    throw error;
  }
}

async function recoverLatestAttemptFromToken(token: string) {
  const rows = await prisma.$queryRaw<InviteAttemptRow[]>`
    select
      ia.attempt_id::text,
      ia.interview_id::text,
      ia.attempt_number,
      ia.ends_at,
      i.candidate_id::text,
      c.full_name as candidate_name
    from public.interview_invites ii
    join public.interviews i
      on i.interview_id = ii.interview_id
    join public.interview_attempts ia
      on ia.interview_id = ii.interview_id
    left join public.candidates c
      on c.candidate_id = i.candidate_id
    where ii.token = ${token}::text
    order by ia.attempt_number desc, ia.started_at desc
    limit 1
  `;
  const row = rows[0];

  if (!row) {
    return undefined;
  }

  return {
    attempt_id: row.attempt_id,
    interview_id: row.interview_id,
    attempt_number: row.attempt_number,
    reused: true,
    candidate_name: row.candidate_name,
    candidate_id: row.candidate_id,
    ends_at: row.ends_at,
  } satisfies SessionStartRow;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as RequestBody;
    const token = body.token?.trim();

    if (!token) {
      return Response.json({ error: "token is required" }, { status: 400 });
    }

    let attempt: SessionStartRow | undefined;

    const inviteAccessType = await getInviteAccessType(token);

    if (String(inviteAccessType ?? "").toUpperCase() === "RECOVERY") {
      const recoveryAttempt = await startRecoveryAttemptFromToken(token);
      attempt = normalizeSessionStartRow({
        attempt_id: recoveryAttempt.attempt_id,
        interview_id: recoveryAttempt.interview_id,
        attempt_number: recoveryAttempt.attempt_number,
        reused: recoveryAttempt.reused,
        candidate_name: recoveryAttempt.candidate_name,
        candidate_id: recoveryAttempt.candidate_id,
        ends_at: recoveryAttempt.ends_at,
      });
    }

    try {
      if (attempt) {
        throw new Error("__RECOVERY_ATTEMPT_READY__");
      }

      const rows = await prisma.$queryRaw<SessionStartRow[]>`
        select *
        from public.start_interview_session(${token}::text)
      `;

      attempt = normalizeSessionStartRow(rows[0]);
    } catch (error) {
      if (error instanceof Error && error.message === "__RECOVERY_ATTEMPT_READY__") {
        // Continue with the recovery attempt created above.
      } else
      if (
        !hasMissingFunctionError(error, "public.start_interview_session") &&
        !hasMissingDatabaseRoutineError(error)
      ) {
        throw error;
      } else {

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
              candidate_id: true,
              duration_minutes: true,
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

      if (
        latestAttempt &&
        !isAttemptStatusFinalized(latestAttempt.status) &&
        !["COMPLETING", "FINALIZING"].includes(String(latestAttempt.status ?? "").toUpperCase())
      ) {
        attempt = {
          attempt_id: latestAttempt.attempt_id,
          interview_id: latestAttempt.interview_id,
          attempt_number: latestAttempt.attempt_number,
          reused: true,
          candidate_name: invite.interviews.candidates.full_name,
          candidate_id: invite.interviews.candidate_id,
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
              ends_at: new Date(
                now.getTime() +
                  Math.max(invite.interviews.duration_minutes ?? 30, 1) *
                    60 *
                    1000
              ),
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
          candidate_id: invite.interviews.candidate_id,
        };

        const timingRows = await prisma.$queryRaw<AttemptTimingRow[]>`
          select attempt_id, ends_at, ${invite.interviews.duration_minutes ?? 30}::int as duration_minutes
          from public.interview_attempts
          where attempt_id = ${createdAttempt.attempt_id}::uuid
          limit 1
        `;

        attempt.ends_at = timingRows[0]?.ends_at ?? null;
      }
      }
    }

    if (!attempt) {
      return Response.json(
        { error: "Failed to start interview session" },
        { status: 500 }
      );
    }

    attempt = normalizeSessionStartRow(attempt);

    if (!attempt) {
      return Response.json(
        { error: "Failed to normalize interview session" },
        { status: 500 }
      );
    }

    if (!looksLikeUuid(attempt.attempt_id) || !looksLikeUuid(attempt.interview_id)) {
      attempt = normalizeSessionStartRow(await recoverLatestAttemptFromToken(token));
    }

    if (!attempt || !looksLikeUuid(attempt.attempt_id) || !looksLikeUuid(attempt.interview_id)) {
      logInterviewEvent("error", "session.start_invalid_attempt_payload", {
        payloadKeys: Object.keys(attempt ?? {}),
        payload: attempt ?? null,
      });

      return Response.json(
        { error: "Unable to resolve a valid interview attempt for this invite" },
        { status: 500 }
      );
    }

    const attemptId = attempt.attempt_id;
    const interviewId = attempt.interview_id;

    const timingRows = await prisma.$queryRaw<AttemptTimingRow[]>`
      select
        ia.attempt_id,
        ia.ends_at,
        i.duration_minutes
      from public.interview_attempts ia
      join public.interviews i
        on i.interview_id = ia.interview_id
      where ia.attempt_id = ${attemptId}::uuid
      limit 1
    `;
    const timing = timingRows[0] ?? null;

    if (!attempt.ends_at && timing?.ends_at) {
      attempt.ends_at = timing.ends_at;
    }

    if (!attempt.ends_at && timing) {
      const endsAt = new Date(
        Date.now() + Math.max(timing.duration_minutes ?? 30, 1) * 60 * 1000
      );

      await prisma.$executeRaw`
        update public.interview_attempts
        set ends_at = ${endsAt}::timestamptz
        where attempt_id = ${attemptId}::uuid
          and ends_at is null
      `;

      attempt.ends_at = endsAt;
    }

    let candidateName = attempt.candidate_name ?? null;
    let candidateId = attempt.candidate_id ?? null;

    if (!candidateName || !candidateId) {
      const inviteWithCandidate = await prisma.interview_invites.findUnique({
        where: {
          token,
        },
        select: {
          interviews: {
            select: {
              candidate_id: true,
              candidates: {
                select: {
                  full_name: true,
                },
              },
            },
          },
        },
      });

      candidateName =
        candidateName ??
        inviteWithCandidate?.interviews.candidates.full_name ??
        null;
      candidateId = candidateId ?? inviteWithCandidate?.interviews.candidate_id ?? null;
    }

    return Response.json({
      attemptId,
      interviewId,
      attemptNumber: attempt.attempt_number,
      reused: attempt.reused,
      endsAt: attempt.ends_at,
      serverNow: new Date().toISOString(),
      candidateId,
      candidateName,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to start interview session";

    logInterviewEvent("error", "session.start_failed", {
      prismaFailure: error,
    });

    return Response.json({ error: message }, { status: 500 });
  }
}
