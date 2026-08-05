import { prisma } from "@/app/lib/prisma";
import { assertUuid, logInterviewEvent } from "@/app/lib/interviewReliability";

type WarRoomActionRow = {
  action_id: string;
  attempt_id: string;
  interview_id: string;
  action_type: string;
  recommendation: string | null;
  note: string | null;
  created_by: string | null;
  created_at: Date | string;
};

type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JsonValue }
  | JsonValue[];

function actionToSignalValue(action: WarRoomActionRow): JsonValue {
  return {
    source: "war_room",
    actionId: action.action_id,
    interviewId: action.interview_id,
    actionType: action.action_type,
    recommendation: action.recommendation,
    note: action.note,
    createdBy: action.created_by,
    createdAt: new Date(action.created_at).toISOString(),
  };
}

export async function syncWarRoomActionsToCalm(params: {
  attemptId: string;
  since?: string | null;
}) {
  const attemptId = assertUuid(params.attemptId, "attemptId");
  const since = params.since ? new Date(params.since) : null;

  const actions = await prisma.$queryRaw<WarRoomActionRow[]>`
    select
      action_id,
      attempt_id,
      interview_id,
      action_type,
      recommendation,
      note,
      created_by,
      created_at
    from public.war_room_actions
    where attempt_id = ${attemptId}::uuid
      and (${since}::timestamptz is null or created_at > ${since}::timestamptz)
    order by created_at asc, action_id asc
    limit 25
  `;

  if (actions.length > 0) {
    const payload = actions.map((action: WarRoomActionRow) => ({
      actionId: action.action_id,
      value: actionToSignalValue(action),
    }));

    await prisma.$executeRaw`
      insert into public.interview_signals (attempt_id, type, value)
      select
        ${attemptId}::uuid,
        ${"war_room_action"}::text,
        candidate.value
      from jsonb_to_recordset(${JSON.stringify(payload)}::jsonb) as candidate(
        "actionId" text,
        value jsonb
      )
      where not exists (
        select 1
        from public.interview_signals existing
        where existing.attempt_id = ${attemptId}::uuid
          and existing.type = ${"war_room_action"}::text
          and existing.value ->> 'actionId' = candidate."actionId"
      )
    `;
  }

  if (actions.length > 0) {
    logInterviewEvent("info", "war_room.actions_synced", {
      attemptId,
      count: actions.length,
      latestActionAt: new Date(actions[actions.length - 1].created_at).toISOString(),
    });
  }

  return actions.map((action: WarRoomActionRow) => ({
    actionId: action.action_id,
    attemptId: action.attempt_id,
    interviewId: action.interview_id,
    actionType: action.action_type,
    recommendation: action.recommendation,
    note: action.note,
    createdBy: action.created_by,
    createdAt: new Date(action.created_at).toISOString(),
  }));
}

type PendingRecruiterProbeRow = {
  action_id: string;
  note: string | null;
};

export type PendingRecruiterProbe = {
  actionId: string;
  note: string | null;
};

/**
 * Atomically claims the oldest un-fulfilled "Probe Deeper" action for an
 * attempt so the next question generated for the candidate can honor it.
 * The UPDATE ... WHERE action_id = (SELECT ... FOR UPDATE SKIP LOCKED)
 * shape claims and marks the row consumed in a single statement, so two
 * concurrent next-question calls can never both claim the same action.
 */
export async function claimPendingRecruiterProbe(
  attemptId: string,
): Promise<PendingRecruiterProbe | null> {
  const attempt = assertUuid(attemptId, "attemptId");

  const rows = await prisma.$queryRaw<PendingRecruiterProbeRow[]>`
    update public.war_room_actions
    set consumed_at = now()
    where action_id = (
      select action_id
      from public.war_room_actions
      where attempt_id = ${attempt}::uuid
        and action_type = 'follow_up'
        and consumed_at is null
      order by created_at asc
      limit 1
      for update skip locked
    )
    returning action_id, note
  `;

  const claimed = rows[0];

  if (!claimed) {
    return null;
  }

  logInterviewEvent("info", "war_room.probe_claimed", {
    attemptId: attempt,
    actionId: claimed.action_id,
  });

  return { actionId: claimed.action_id, note: claimed.note };
}

/**
 * Records which session question fulfilled a recruiter's probe request, for
 * the war-room audit trail.
 */
export async function markRecruiterProbeQuestion(
  actionId: string,
  sessionQuestionId: string,
): Promise<void> {
  const action = assertUuid(actionId, "actionId");
  const sessionQuestion = assertUuid(sessionQuestionId, "sessionQuestionId");

  await prisma.$executeRaw`
    update public.war_room_actions
    set consumed_session_question_id = ${sessionQuestion}::uuid
    where action_id = ${action}::uuid
  `;
}
