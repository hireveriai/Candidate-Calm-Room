import { prisma } from "@/app/lib/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const RETENTION_DAYS = 7;

function isAuthorizedCronRequest(request: Request) {
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    return true;
  }

  return request.headers.get("authorization") === `Bearer ${cronSecret}`;
}

export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request)) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const deleted = await prisma.$executeRaw`
      delete from public.interview_browser_logs
      where occurred_at < now() - (${RETENTION_DAYS} * interval '1 day')
    `;

    return Response.json({ ok: true, deleted: Number(deleted) });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Failed to purge browser logs",
      },
      { status: 500 }
    );
  }
}
