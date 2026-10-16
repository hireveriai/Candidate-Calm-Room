// Cron routes are public URLs, called by Vercel Cron and by the external
// scheduler (cron-job.org) with "Authorization: Bearer <CRON_SECRET>". Fail
// closed: without a configured secret nothing may trigger them.
export function isAuthorizedCronRequest(
  request: Request,
  cronSecret: string | undefined = process.env.CRON_SECRET,
) {
  const secret = cronSecret?.trim();
  return Boolean(secret) && request.headers.get("authorization") === `Bearer ${secret}`;
}
