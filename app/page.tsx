import { notFound, redirect } from "next/navigation";

import { prisma } from "@/app/lib/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function Home() {
  const now = new Date();

  const invite = await prisma.interview_invites.findFirst({
    where: {
      status: "ACTIVE",
      OR: [{ expires_at: null }, { expires_at: { gt: now } }],
    },
    orderBy: {
      created_at: "desc",
    },
    select: {
      token: true,
    },
  });

  if (!invite?.token) {
    notFound();
  }

  redirect(`/interview/${invite.token}`);
}
