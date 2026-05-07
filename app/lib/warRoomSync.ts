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

  for (const action of actions) {
    const value = actionToSignalValue(action);

    await prisma.$executeRaw`
      insert into public.interview_signals (attempt_id, type, value)
      select ${attemptId}::uuid, ${"war_room_action"}::text, ${JSON.stringify(value)}::jsonb
      where not exists (
        select 1
        from public.interview_signals
        where attempt_id = ${attemptId}::uuid
          and type = ${"war_room_action"}::text
          and value ->> 'actionId' = ${action.action_id}::text
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
