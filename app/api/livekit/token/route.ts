import { NextRequest, NextResponse } from "next/server";
import { AccessToken } from "livekit-server-sdk";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const publisherRole = "publisher";

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const room = searchParams.get("room")?.trim();
  const userId = searchParams.get("userId")?.trim();
  const role = searchParams.get("role")?.trim();

  if (!room || !userId || !role) {
    return NextResponse.json(
      { error: "room, userId, and role are required query params" },
      { status: 400 },
    );
  }

  if (role !== publisherRole) {
    return NextResponse.json(
      { error: "role must be publisher" },
      { status: 400 },
    );
  }

  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;

  if (!apiKey || !apiSecret) {
    return NextResponse.json(
      { error: "LiveKit server credentials are missing" },
      { status: 500 },
    );
  }

  const token = new AccessToken(apiKey, apiSecret, {
    identity: userId,
    name: userId,
  });

  token.addGrant({
    room,
    roomJoin: true,
    canPublish: true,
    canSubscribe: false,
    canPublishData: true,
  });

  return NextResponse.json({ token: await token.toJwt() });
}
