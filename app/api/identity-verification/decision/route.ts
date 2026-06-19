import { prisma } from "@/app/lib/prisma";
import {
  auditVerification,
  ensureVerification,
  getLatestVerification,
  getRequestIp,
  resolveInviteContext,
} from "@/app/lib/identity-verification/server";
import { getIdentityProvider } from "@/app/lib/identity-verification/providers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type DecisionBody = {
  token?: string;
  action?: "skip" | "connect_digilocker" | "continue_after_failure";
  country?: string;
};

export async function POST(request: Request) {
  const body = (await request.json()) as DecisionBody;
  const token = body.token?.trim();
  if (!token || !body.action) {
    return Response.json({ error: "Token and action are required" }, { status: 400 });
  }

  const context = await resolveInviteContext(token);
  if (!context) {
    return Response.json({ error: "Interview invite is invalid or expired" }, { status: 404 });
  }

  let verification =
    (await getLatestVerification(context.interview_id)) ??
    (await ensureVerification({
      candidateId: context.candidate_id,
      interviewId: context.interview_id,
      country: body.country || "India",
      method: body.action === "connect_digilocker" ? "digilocker" : "none",
      provider: body.action === "connect_digilocker" ? "digilocker" : "manual_upload",
    }));

  if (body.action === "skip") {
    await prisma.$executeRaw`
      update public.candidate_identity_verifications
      set verification_status = 'skipped',
          verification_method = 'none'
      where id = ${verification.id}::uuid
        and candidate_id = ${context.candidate_id}::uuid
    `;
    await auditVerification({
      verificationId: verification.id,
      candidateId: context.candidate_id,
      interviewId: context.interview_id,
      action: "verification.skipped",
      ip: getRequestIp(request.headers),
    });
    verification = (await getLatestVerification(context.interview_id))!;
    return Response.json({ verification, allowContinue: true });
  }

  if (body.action === "continue_after_failure") {
    await auditVerification({
      verificationId: verification.id,
      candidateId: context.candidate_id,
      interviewId: context.interview_id,
      action: "verification.failure_bypassed",
      ip: getRequestIp(request.headers),
    });
    return Response.json({ verification, allowContinue: true });
  }

  const providerResult = await getIdentityProvider("digilocker").connect();
  await prisma.$executeRaw`
    update public.candidate_identity_verifications
    set verification_method = 'digilocker',
        verification_provider = 'digilocker',
        digilocker_connected = ${providerResult.connected},
        verification_status = ${providerResult.connected ? "verified" : "failed"}
    where id = ${verification.id}::uuid
      and candidate_id = ${context.candidate_id}::uuid
  `;

  await auditVerification({
    verificationId: verification.id,
    candidateId: context.candidate_id,
    interviewId: context.interview_id,
    action: providerResult.connected
      ? "digilocker.connected"
      : "digilocker.connection_failed",
    ip: getRequestIp(request.headers),
    metadata: { message: providerResult.message ?? null },
  });

  verification = (await getLatestVerification(context.interview_id))!;
  return Response.json({
    verification,
    allowContinue: !providerResult.connected,
    message: providerResult.message,
  });
}

