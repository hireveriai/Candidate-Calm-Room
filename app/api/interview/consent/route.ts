import { prisma } from "@/app/lib/prisma";
import { getRequestIp } from "@/app/lib/identity-verification/server";
import { INTERVIEW_CONSENT_VERSION, isCurrentConsentVersion } from "@/app/lib/interviewConsent";
import { logInterviewEvent } from "@/app/lib/interviewReliability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type ConsentBody = {
  token?: string;
  consentVersion?: string;
};

type InviteRow = {
  invite_id: string;
  interview_id: string;
  candidate_id: string | null;
};

/**
 * Records the candidate's consent for an interview. Possession of the invite
 * token is the candidate's credential here, as for session start. Idempotent:
 * accepting again on reload is a no-op.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as ConsentBody;
  const token = body.token?.trim();

  if (!token) {
    return Response.json({ error: "token is required" }, { status: 400 });
  }

  if (!isCurrentConsentVersion(body.consentVersion)) {
    return Response.json(
      { error: "Please review the latest interview consent and try again.", consentVersion: INTERVIEW_CONSENT_VERSION },
      { status: 409 }
    );
  }

  try {
    const invites = await prisma.$queryRaw<InviteRow[]>`
      select ii.invite_id::text, ii.interview_id::text, i.candidate_id::text
      from public.interview_invites ii
      join public.interviews i on i.interview_id = ii.interview_id
      where ii.token = ${token}::text
        and coalesce(ii.status, 'ACTIVE') = 'ACTIVE'
        and (ii.expires_at is null or ii.expires_at > now())
      limit 1
    `;
    const invite = invites[0];

    if (!invite) {
      return Response.json({ error: "This interview link is invalid or no longer available." }, { status: 404 });
    }

    await prisma.$executeRaw`
      insert into public.interview_consents (
        interview_id, candidate_id, invite_id, consent_version, ip_address, user_agent
      )
      values (
        ${invite.interview_id}::uuid,
        ${invite.candidate_id}::uuid,
        ${invite.invite_id}::uuid,
        ${INTERVIEW_CONSENT_VERSION},
        ${getRequestIp(request.headers)},
        ${request.headers.get("user-agent")?.slice(0, 500) ?? null}
      )
      on conflict (interview_id, consent_version) do nothing
    `;

    return Response.json({ ok: true, consentVersion: INTERVIEW_CONSENT_VERSION });
  } catch (error) {
    logInterviewEvent("error", "consent.record_failed", { prismaFailure: error });
    return Response.json({ error: "Unable to record consent. Please try again." }, { status: 500 });
  }
}
