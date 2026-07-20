import { runInterviewWatchdog } from "@/app/lib/interviewWatchdog";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

function isAuthorizedCronRequest(request: Request) {
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    return true;
  }

  return request.headers.get("authorization") === `Bearer ${cronSecret}`;
}

async function executeWatchdog() {
  try {
    const result = await runInterviewWatchdog();
    return Response.json(result);
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to run interview watchdog",
      },
      { status: 500 }
    );
  }
}

export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request)) {
    return new Response("Unauthorized", { status: 401 });
  }

  return executeWatchdog();
}

export async function POST() {
  return executeWatchdog();
}
