import { runDataRetention } from "@/app/lib/dataRetention";
import { logInterviewEvent } from "@/app/lib/interviewReliability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

// Unlike purge-browser-logs, this job deletes candidate data, so it refuses to
// run unless CRON_SECRET is configured (Vercel Cron sends it automatically).
function isAuthorizedCronRequest(request: Request) {
  const cronSecret = process.env.CRON_SECRET?.trim();
  return Boolean(cronSecret) && request.headers.get("authorization") === `Bearer ${cronSecret}`;
}

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
