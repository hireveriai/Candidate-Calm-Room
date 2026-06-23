import { prisma } from "@/app/lib/prisma";

type RecruiterSession = {
  userId: string;
  organizationId: string;
  role: string;
};

type SessionRow = {
  user_id: string;
  organization_id: string;
  role: string;
};

type SupabaseAuthUser = {
  id?: string;
  email?: string;
};

export class RecruiterAccessError extends Error {
  constructor(
    message: string,
    public readonly status: 401 | 403 | 404,
  ) {
    super(message);
    this.name = "RecruiterAccessError";
  }
}

function readCookie(request: Request, name: string) {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) {
    return null;
  }

  for (const cookie of cookieHeader.split(";")) {
    const [key, ...valueParts] = cookie.trim().split("=");
    if (key === name) {
      return decodeURIComponent(valueParts.join("="));
    }
  }

  return null;
}

function extractAccessToken(request: Request) {
  const authorization = request.headers.get("authorization")?.trim();
  if (authorization?.toLowerCase().startsWith("bearer ")) {
    return authorization.slice("bearer ".length).trim();
  }

  return (
    readCookie(request, "accessToken") ??
    readCookie(request, "authToken") ??
    readCookie(request, "access_token")
  );
}

function isRecruiterRole(role: string) {
  const normalized = role.trim().toLowerCase();
  return (
    normalized.includes("recruiter") ||
    normalized.includes("admin") ||
    normalized.includes("hiring")
  );
}

async function resolveSupabaseUser(token: string) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!supabaseUrl || !anonKey) {
    return null;
  }

  const response = await fetch(
    `${supabaseUrl.replace(/\/+$/, "")}/auth/v1/user`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: anonKey,
      },
      cache: "no-store",
    },
  );

  if (!response.ok) {
    return null;
  }

  const authUser = (await response.json()) as SupabaseAuthUser;
  if (!authUser.id && !authUser.email) {
    return null;
  }

  const users = await prisma.$queryRaw<SessionRow[]>`
    select
      u.user_id::text,
      u.organization_id::text,
      u.role
    from public.users u
    where u.is_active = true
      and (
        (${authUser.id ?? null}::uuid is not null and u.user_id = ${
          authUser.id ?? null
        }::uuid)
        or (${authUser.email ?? null}::text is not null and lower(u.email) = lower(${
          authUser.email ?? null
        }))
      )
    limit 1
  `;

  return users[0] ?? null;
}

export async function requireRecruiterAttemptAccess(
  request: Request,
  attemptId: string,
): Promise<RecruiterSession> {
  const token = extractAccessToken(request);
  if (!token) {
    throw new RecruiterAccessError("Recruiter authentication is required", 401);
  }

  const sessions = await prisma.$queryRaw<SessionRow[]>`
    select
      u.user_id::text,
      u.organization_id::text,
      u.role
    from public.user_sessions us
    join public.users u
      on u.user_id = us.user_id
    where us.access_token = ${token}
      and coalesce(us.is_revoked, false) = false
      and (us.expires_at is null or us.expires_at > timezone('utc', now()))
      and u.is_active = true
    limit 1
  `;

  const session = sessions[0] ?? (await resolveSupabaseUser(token));
  if (!session || !isRecruiterRole(session.role)) {
    throw new RecruiterAccessError("Recruiter session is invalid or expired", 401);
  }

  const attempts = await prisma.$queryRaw<Array<{ organization_id: string }>>`
    select i.organization_id::text
    from public.interview_attempts ia
    join public.interviews i
      on i.interview_id = ia.interview_id
    where ia.attempt_id = ${attemptId}::uuid
    limit 1
  `;

  const attempt = attempts[0];
  if (!attempt) {
    throw new RecruiterAccessError("Interview attempt was not found", 404);
  }

  if (attempt.organization_id !== session.organization_id) {
    throw new RecruiterAccessError(
      "Recruiter cannot access another organization’s recording",
      403,
    );
  }

  return {
    userId: session.user_id,
    organizationId: session.organization_id,
    role: session.role,
  };
}
