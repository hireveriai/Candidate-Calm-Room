import { prisma } from "@/app/lib/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const attempts = await prisma.interview_attempts.findMany({
    take: 1,
  });

  return Response.json(attempts);
}
