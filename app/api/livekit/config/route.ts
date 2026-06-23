import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function getLiveKitBrowserUrl() {
  const configured =
    process.env.NEXT_PUBLIC_LIVEKIT_URL?.trim() ||
    process.env.LIVEKIT_URL?.trim();

  if (!configured) {
    return null;
  }

  if (configured.startsWith("https://")) {
    return `wss://${configured.slice("https://".length)}`;
  }

  if (configured.startsWith("http://")) {
    return `ws://${configured.slice("http://".length)}`;
  }

  return configured;
}

export async function GET() {
  const liveKitUrl = getLiveKitBrowserUrl();

  if (!liveKitUrl) {
    return NextResponse.json(
      { error: "LiveKit URL is not configured" },
      { status: 500 },
    );
  }

  return NextResponse.json(
    { liveKitUrl },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
