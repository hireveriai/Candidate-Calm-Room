import { notFound, redirect } from "next/navigation";

import { prisma } from "@/app/lib/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type AvailableInviteRow = {
  token: string;
};

export default async function Home() {
  const now = new Date();

  const invites = await prisma.$queryRaw<AvailableInviteRow[]>`
    select ii.token
    from public.interview_invites ii
    join public.interviews i
      on i.interview_id = ii.interview_id
    where ii.status = 'ACTIVE'
      and (ii.expires_at is null or ii.expires_at > ${now}::timestamptz)
      and (
        coalesce(ii.attempts_used, 0) <
          coalesce(ii.max_attempts, i.max_attempts, 1)
        or exists (
          select 1
          from public.interview_attempts ia
          where ia.interview_id = ii.interview_id
            and upper(coalesce(ia.status, '')) not in (
              'COMPLETED',
              'TERMINATED',
              'ABANDONED',
              'EXPIRED',
              'FINALIZED',
              'FAILED',
              'TIME_EXPIRED',
              'COMPLETING',
              'FINALIZING'
            )
        )
      )
    order by ii.created_at desc
    limit 1
  `;
  const invite = invites[0];

  if (!invite?.token) {
    notFound();
  }

  redirect(`/interview/${invite.token}`);
}
