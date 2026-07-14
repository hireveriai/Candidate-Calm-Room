import { normalizeCountry, getLatestVerification, resolveInviteContext } from "@/app/lib/identity-verification/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token")?.trim();
  if (!token) {
    return Response.json({ error: "Invite token is required" }, { status: 400 });
  }

  const context = await resolveInviteContext(token);
  if (!context) {
    return Response.json({ error: "Interview invite is invalid or expired" }, { status: 404 });
  }

  return Response.json(
    {
      interviewId: context.interview_id,
      candidateId: context.candidate_id,
      candidateName: context.candidate_name,
      candidateCountry: normalizeCountry(context.candidate_country),
      jobCountry: normalizeCountry(context.job_country),
      deviceRequirement: context.device_requirement ?? "ANY_DEVICE",
      verification: await getLatestVerification(context.interview_id),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
