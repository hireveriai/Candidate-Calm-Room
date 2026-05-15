import { runInterviewWatchdog } from "@/app/lib/interviewWatchdog";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST() {
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
