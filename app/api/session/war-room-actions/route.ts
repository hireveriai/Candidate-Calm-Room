import { syncWarRoomActionsToCalm } from "@/app/lib/warRoomSync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RequestBody = {
  attemptId?: string;
  since?: string | null;
};

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as RequestBody;
    const actions = await syncWarRoomActionsToCalm({
      attemptId: body.attemptId ?? "",
      since: body.since ?? null,
    });

    return Response.json({
      actions,
      syncedAt: new Date().toISOString(),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to sync war-room actions";

    return Response.json({ error: message }, { status: 500 });
  }
}
