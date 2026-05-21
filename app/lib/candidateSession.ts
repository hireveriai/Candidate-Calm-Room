import crypto from "crypto";

import { prisma } from "@/app/lib/prisma";
import { assertUuid, logInterviewEvent } from "@/app/lib/interviewReliability";

const COOKIE_NAME = "hv_candidate_session";
const TOKEN_VERSION = 1;
const DEFAULT_TTL_SECONDS = 60 * 60 * 6;

type CandidateSessionClaims = {
  v: number;
  attemptId: string;
  interviewId: string;
  candidateId: string | null;
  tokenHash: string;
  iat: number;
  exp: number;
};

type AttemptOwnershipRow = {
  attempt_id: string;
  interview_id: string;
  candidate_id: string | null;
};

function base64UrlEncode(value: Buffer | string) {
  return Buffer.from(value)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(value: string) {
  const normalized = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Buffer.from(normalized, "base64").toString("utf8");
}

function getCandidateSessionSecret() {
  const secret =
    process.env.CANDIDATE_SESSION_SECRET ||
    process.env.JWT_SECRET ||
    process.env.NEXTAUTH_SECRET ||
    process.env.LIVEKIT_API_SECRET;

  if (!secret) {
    throw new Error("CANDIDATE_SESSION_SECRET is required for candidate session security");
  }

  return secret;
}

function signPayload(payload: string) {
  return base64UrlEncode(
    crypto.createHmac("sha256", getCandidateSessionSecret()).update(payload).digest()
  );
}

function tokenHash(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function timingSafeEqualString(left: string, right: string) {
  try {
    return crypto.timingSafeEqual(Buffer.from(left), Buffer.from(right));
  } catch {
    return false;
  }
}

function parseCookies(cookieHeader: string | null) {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) {
    return cookies;
  }

  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) {
      continue;
    }

    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key) {
      cookies[key] = value;
    }
  }

  return cookies;
}

function extractBearerToken(request: Request) {
  const authorization = request.headers.get("authorization");
  if (authorization?.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }

  return request.headers.get("x-candidate-session")?.trim() || null;
}

function getSessionTokenFromRequest(request: Request) {
  return (
    extractBearerToken(request) ||
    parseCookies(request.headers.get("cookie"))[COOKIE_NAME] ||
    null
  );
}

function verifyCandidateSessionToken(token: string): CandidateSessionClaims {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) {
    throw new Error("Candidate session token is malformed");
  }

  const expected = signPayload(payload);
  if (!timingSafeEqualString(signature, expected)) {
    throw new Error("Candidate session token signature is invalid");
  }

  const claims = JSON.parse(base64UrlDecode(payload)) as CandidateSessionClaims;
  const now = Math.floor(Date.now() / 1000);

  if (claims.v !== TOKEN_VERSION) {
    throw new Error("Candidate session token version is unsupported");
  }

  if (!claims.exp || claims.exp <= now) {
    throw new Error("Candidate session token has expired");
  }

  assertUuid(claims.attemptId, "candidate session attemptId");
  assertUuid(claims.interviewId, "candidate session interviewId");
  if (claims.candidateId) {
    assertUuid(claims.candidateId, "candidate session candidateId");
  }

  return claims;
}

async function getAttemptOwnership(attemptId: string) {
  const rows = await prisma.$queryRaw<AttemptOwnershipRow[]>`
    select
      ia.attempt_id::text,
      ia.interview_id::text,
      i.candidate_id::text
    from public.interview_attempts ia
    join public.interviews i
      on i.interview_id = ia.interview_id
    where ia.attempt_id = ${attemptId}::uuid
    limit 1
  `;

  return rows[0] ?? null;
}

export function createCandidateSessionToken(params: {
  attemptId: string;
  interviewId: string;
  candidateId?: string | null;
  inviteToken: string;
  ttlSeconds?: number;
}) {
  const now = Math.floor(Date.now() / 1000);
  const ttlSeconds = Math.max(params.ttlSeconds ?? DEFAULT_TTL_SECONDS, 60);
  const claims: CandidateSessionClaims = {
    v: TOKEN_VERSION,
    attemptId: assertUuid(params.attemptId, "attemptId"),
    interviewId: assertUuid(params.interviewId, "interviewId"),
    candidateId: params.candidateId ? assertUuid(params.candidateId, "candidateId") : null,
    tokenHash: tokenHash(params.inviteToken),
    iat: now,
    exp: now + ttlSeconds,
  };
  const payload = base64UrlEncode(JSON.stringify(claims));

  return `${payload}.${signPayload(payload)}`;
}

export function candidateSessionCookie(token: string) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DEFAULT_TTL_SECONDS}${secure}`;
}

export async function requireCandidateSession(
  request: Request,
  params: {
    attemptId: string;
    interviewId?: string | null;
    candidateId?: string | null;
    operation: string;
  }
) {
  const attemptId = assertUuid(params.attemptId, "attemptId");
  const rawToken = getSessionTokenFromRequest(request);

  if (!rawToken) {
    logInterviewEvent("warn", "candidate_session.missing", {
      attemptId,
      operation: params.operation,
    });
    throw new Error("Candidate session is required");
  }

  const claims = verifyCandidateSessionToken(decodeURIComponent(rawToken));

  if (claims.attemptId !== attemptId) {
    logInterviewEvent("warn", "candidate_session.attempt_mismatch", {
      attemptId,
      operation: params.operation,
      sessionAttemptId: claims.attemptId,
    });
    throw new Error("Candidate session does not match this attempt");
  }

  if (params.interviewId && claims.interviewId !== params.interviewId) {
    throw new Error("Candidate session does not match this interview");
  }

  if (params.candidateId && claims.candidateId && claims.candidateId !== params.candidateId) {
    throw new Error("Candidate session does not match this candidate");
  }

  const ownership = await getAttemptOwnership(attemptId);
  if (!ownership) {
    throw new Error("Interview attempt not found for candidate session");
  }

  if (ownership.interview_id !== claims.interviewId) {
    throw new Error("Candidate session interview ownership is invalid");
  }

  if (
    claims.candidateId &&
    ownership.candidate_id &&
    ownership.candidate_id !== claims.candidateId
  ) {
    throw new Error("Candidate session candidate ownership is invalid");
  }

  return {
    ...claims,
    candidateId: ownership.candidate_id ?? claims.candidateId,
  };
}

