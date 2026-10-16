import { isAuthorizedCronRequest } from "@/app/lib/cronAuth";
import { runInterviewWatchdog } from "@/app/lib/interviewWatchdog";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

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

export async function POST(request: Request) {
  if (!isAuthorizedCronRequest(request)) {
    return new Response("Unauthorized", { status: 401 });
  }

  return executeWatchdog();
}
