import { NextRequest, NextResponse } from "next/server";
import { AccessToken } from "livekit-server-sdk";
import { requireCandidateSession } from "@/app/lib/candidateSession";
import { assertUuid, logInterviewEvent } from "@/app/lib/interviewReliability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const publisherRole = "publisher";

export async function GET(request: NextRequest) {
  try {
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
    assertUuid(room, "room");
    await requireCandidateSession(request, {
      attemptId: room,
      operation: "livekit.token",
    });

    const expectedIdentity = `candidate-publisher-${room}`;
    if (userId !== expectedIdentity) {
      logInterviewEvent("warn", "livekit.identity_rewritten", {
        attemptId: room,
        requestedIdentity: userId,
        expectedIdentity,
      });
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
      identity: expectedIdentity,
      name: expectedIdentity,
      ttl: "15m",
    });

    token.addGrant({
      room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: false,
      canPublishData: true,
    });

    return NextResponse.json({ token: await token.toJwt() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to issue LiveKit token";
    logInterviewEvent("warn", "livekit.token_denied", {
      prismaFailure: error,
    });
    return NextResponse.json({ error: message }, { status: 401 });
  }
}
