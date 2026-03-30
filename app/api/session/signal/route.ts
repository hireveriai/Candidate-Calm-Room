import { prisma } from "@/app/lib/prisma";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JsonValue }
  | JsonValue[];

type RequestBody = {
  attemptId?: string;
  type?: string;
  value?: JsonValue;
};

type InterviewSignalRecord = {
  signal_id: string;
  attempt_id: string;
  type: string;
  value: JsonValue;
  created_at: string;
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as RequestBody;
    const { attemptId, type, value } = body;

    if (!attemptId || !type || value === undefined) {
      return Response.json(
        { error: "attemptId, type, and value are required" },
        { status: 400 }
      );
    }

    const [signal] = await prisma.$queryRaw<InterviewSignalRecord[]>`
      insert into interview_signals (attempt_id, type, value)
      values (${attemptId}::uuid, ${type}, ${JSON.stringify(value)}::jsonb)
      returning signal_id, attempt_id, type, value, created_at
    `;

    return Response.json(signal);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to create interview signal";

    return Response.json({ error: message }, { status: 500 });
  }
}
