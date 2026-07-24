import { prisma } from "@/app/lib/prisma";
import {
  candidateSessionCookie,
  createCandidateSessionToken,
} from "@/app/lib/candidateSession";
import {
  isAttemptStatusFinalized,
  logInterviewEvent,
} from "@/app/lib/interviewReliability";
import { startRecoveryAttemptFromToken } from "@/app/lib/interviewRecovery";
import { isAmbiguousDatabaseColumnError } from "@/app/lib/sessionStartDatabaseError";

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

type RevivableAttemptRow = InviteAttemptRow & {
  answer_count: number;
  recording_count: number;
  duration_minutes: number | null;
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

function classifySessionStartError(error: unknown) {
  const rawMessage =
    error instanceof Error ? error.message : "Failed to start interview session";
  const normalized = rawMessage.toLowerCase();

  if (normalized.includes("invite not found")) {
    return {
      status: 404,
      message: "This interview link is invalid or no longer available.",
    };
  }

  if (normalized.includes("invite has expired")) {
    return {
      status: 410,
      message: "This interview link has expired.",
    };
  }

  if (normalized.includes("invite is not active")) {
    return {
      status: 409,
      message: "This interview link is not active.",
    };
  }

  if (normalized.includes("maximum attempts reached")) {
    return {
      status: 409,
      message: "The maximum number of attempts for this interview has been reached.",
    };
  }

  return {
    status: 500,
    message: "Failed to start interview session.",
  };
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

async function reviveEmptyAttemptFromToken(token: string) {
  return prisma.$transaction(async (tx: typeof prisma) => {
    const rows = await tx.$queryRaw<RevivableAttemptRow[]>`
      select
        ia.attempt_id::text,
        ia.interview_id::text,
        ia.attempt_number,
        ia.ends_at,
        i.duration_minutes,
        i.candidate_id::text,
        c.full_name as candidate_name,
        (
          select count(*)::int
          from public.interview_answers ans
          where ans.attempt_id = ia.attempt_id
        ) as answer_count,
        (
          select count(*)::int
          from public.interview_recordings rec
          where rec.attempt_id = ia.attempt_id
        ) as recording_count
      from public.interview_invites ii
      join public.interviews i
        on i.interview_id = ii.interview_id
      join public.interview_attempts ia
        on ia.interview_id = ii.interview_id
      left join public.candidates c
        on c.candidate_id = i.candidate_id
      where ii.token = ${token}::text
        and coalesce(ii.status, 'ACTIVE') = 'ACTIVE'
        and (ii.expires_at is null or ii.expires_at > now())
      order by ia.attempt_number desc, ia.started_at desc
      limit 1
      for update of ia
    `;
    const row = rows[0];

    if (!row || row.answer_count > 0 || row.recording_count > 0) {
      return undefined;
    }

    const endsAt = new Date(
      Date.now() + Math.max(row.duration_minutes ?? 30, 1) * 60 * 1000
    );

    const updatedRows = await tx.$queryRaw<Array<{ ends_at: Date | null }>>`
      update public.interview_attempts
      set status = 'started',
          ended_at = null,
          ends_at = ${endsAt}::timestamptz,
          recording_status = 'PENDING',
          transcript_status = 'PENDING',
          last_activity_at = timezone('utc', now()),
          termination_type = null,
          interruption_reason = null
      where attempt_id = ${row.attempt_id}::uuid
      returning ends_at
    `;

    logInterviewEvent("warn", "session.start_revived_empty_attempt", {
      attemptId: row.attempt_id,
      interviewId: row.interview_id,
      candidateId: row.candidate_id,
      attemptNumber: row.attempt_number,
    });

    return {
      attempt_id: row.attempt_id,
      interview_id: row.interview_id,
      attempt_number: row.attempt_number,
      reused: true,
      candidate_name: row.candidate_name,
      candidate_id: row.candidate_id,
      ends_at: updatedRows[0]?.ends_at ?? endsAt,
    } satisfies SessionStartRow;
  });
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
        !hasMissingDatabaseRoutineError(error) &&
        !isAmbiguousDatabaseColumnError(error)
      ) {
        if (
          error instanceof Error &&
          error.message.toLowerCase().includes("maximum attempts reached")
        ) {
          attempt = normalizeSessionStartRow(
            await reviveEmptyAttemptFromToken(token)
          );

          if (attempt) {
            logInterviewEvent("warn", "session.start_recovered_consumed_empty_invite", {
              attemptId: attempt.attempt_id,
              interviewId: attempt.interview_id,
              candidateId: attempt.candidate_id,
            });
          } else {
            throw error;
          }
        } else {
        throw error;
        }
      } else {

      const now = new Date();
      attempt = await prisma.$transaction(async (tx: typeof prisma) => {
        const inviteRows = await tx.$queryRaw<Array<{
          invite_id: string;
          interview_id: string;
          status: string | null;
          expires_at: Date | null;
          max_attempts: number | null;
          attempts_used: number | null;
          candidate_id: string | null;
          duration_minutes: number | null;
          candidate_name: string | null;
        }>>`
          select
            ii.invite_id::text,
            ii.interview_id::text,
            ii.status,
            ii.expires_at,
            coalesce(ii.max_attempts, i.max_attempts, 1) as max_attempts,
            ii.attempts_used,
            i.candidate_id::text,
            i.duration_minutes,
            c.full_name as candidate_name
          from public.interview_invites ii
          join public.interviews i
            on i.interview_id = ii.interview_id
          left join public.candidates c
            on c.candidate_id = i.candidate_id
          where ii.token = ${token}::text
          limit 1
          for update of ii
        `;
        const invite = inviteRows[0];

        if (!invite) {
          throw new Error("Invite not found");
        }

        if (invite.status && invite.status !== "ACTIVE") {
          throw new Error("Invite is not active");
        }

        if (invite.expires_at && invite.expires_at <= now) {
          throw new Error("Invite has expired");
        }

        const latestAttempts = await tx.$queryRaw<Array<{
          attempt_id: string;
          interview_id: string;
          attempt_number: number;
          status: string | null;
          ends_at: Date | null;
        }>>`
          select
            attempt_id::text,
            interview_id::text,
            attempt_number,
            status,
            ends_at
          from public.interview_attempts
          where interview_id = ${invite.interview_id}::uuid
          order by attempt_number desc, started_at desc
          limit 1
          for update
        `;
        const latestAttempt = latestAttempts[0];

        if (
          latestAttempt &&
          !isAttemptStatusFinalized(latestAttempt.status) &&
          !["COMPLETING", "FINALIZING"].includes(String(latestAttempt.status ?? "").toUpperCase())
        ) {
          await tx.$executeRaw`
            update public.interview_attempts
            set last_activity_at = timezone('utc', now())
            where attempt_id = ${latestAttempt.attempt_id}::uuid
          `;

          logInterviewEvent("info", "session.start_fallback_reused_locked_attempt", {
            attemptId: latestAttempt.attempt_id,
            interviewId: latestAttempt.interview_id,
            candidateId: invite.candidate_id,
          });
          return {
            attempt_id: latestAttempt.attempt_id,
            interview_id: latestAttempt.interview_id,
            attempt_number: latestAttempt.attempt_number,
            reused: true,
            candidate_name: invite.candidate_name,
            candidate_id: invite.candidate_id,
            ends_at: latestAttempt.ends_at,
          } satisfies SessionStartRow;
        }

        const attemptsUsed = invite.attempts_used ?? 0;
        const maxAttempts = invite.max_attempts ?? 1;

        if (attemptsUsed >= maxAttempts) {
          throw new Error("Maximum attempts reached for this invite");
        }

        const nextAttemptNumber = (latestAttempt?.attempt_number ?? 0) + 1;
        const endsAt = new Date(
          now.getTime() + Math.max(invite.duration_minutes ?? 30, 1) * 60 * 1000
        );
        const createdRows = await tx.$queryRaw<Array<{
          attempt_id: string;
          interview_id: string;
          attempt_number: number;
          ends_at: Date | null;
        }>>`
          insert into public.interview_attempts (
            interview_id,
            attempt_number,
            status,
            ends_at
          )
          values (
            ${invite.interview_id}::uuid,
            ${nextAttemptNumber}::integer,
            'started',
            ${endsAt}::timestamptz
          )
          on conflict (interview_id, attempt_number)
          do update
          set status = public.interview_attempts.status
          returning attempt_id::text, interview_id::text, attempt_number, ends_at
        `;
        const createdAttempt = createdRows[0];

        await tx.$executeRaw`
          update public.interview_invites
          set attempts_used = coalesce(attempts_used, 0) + 1,
              used_at = coalesce(used_at, ${now}::timestamptz)
          where invite_id = ${invite.invite_id}::uuid
        `;

        logInterviewEvent("info", "session.start_fallback_created_locked_attempt", {
          attemptId: createdAttempt.attempt_id,
          interviewId: createdAttempt.interview_id,
          candidateId: invite.candidate_id,
          attemptNumber: createdAttempt.attempt_number,
        });

        return {
          attempt_id: createdAttempt.attempt_id,
          interview_id: createdAttempt.interview_id,
          attempt_number: createdAttempt.attempt_number,
          reused: false,
          candidate_name: invite.candidate_name,
          candidate_id: invite.candidate_id,
          ends_at: createdAttempt.ends_at,
        } satisfies SessionStartRow;
      });
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

    if (candidateId) {
      try {
        await prisma.$executeRaw`
          select public.link_identity_verification_attempt(
            ${interviewId}::uuid,
            ${candidateId}::uuid,
            ${attemptId}::uuid
          )
        `;
      } catch (linkError) {
        logInterviewEvent("warn", "identity_verification.attempt_link_failed", {
          attemptId,
          interviewId,
          candidateId,
          error: linkError,
        });
      }
    }

    const candidateSessionToken = createCandidateSessionToken({
      attemptId,
      interviewId,
      candidateId,
      inviteToken: token,
    });

    return Response.json({
      attemptId,
      interviewId,
      attemptNumber: attempt.attempt_number,
      reused: attempt.reused,
      endsAt: attempt.ends_at,
      serverNow: new Date().toISOString(),
      candidateId,
      candidateName,
    }, {
      headers: {
        "Set-Cookie": candidateSessionCookie(candidateSessionToken),
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const classified = classifySessionStartError(error);

    logInterviewEvent("error", "session.start_failed", {
      prismaFailure: error,
    });

    return Response.json(
      { error: classified.message },
      { status: classified.status }
    );
  }
}
