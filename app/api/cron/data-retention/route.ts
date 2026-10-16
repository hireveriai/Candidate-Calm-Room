import { isAuthorizedCronRequest } from "@/app/lib/cronAuth";
import { runDataRetention } from "@/app/lib/dataRetention";
import { logInterviewEvent } from "@/app/lib/interviewReliability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request)) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const report = await runDataRetention();
    logInterviewEvent(report.errors.length ? "warn" : "info", "retention.run", { ...report });
    return Response.json({ ok: report.errors.length === 0, ...report });
  } catch (error) {
    logInterviewEvent("error", "retention.failed", { prismaFailure: error });
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "Data retention run failed" },
      { status: 500 }
    );
  }
}
