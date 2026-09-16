import { prisma } from "@/app/lib/prisma";

// Code similarity ("possible reuse") detection for coding interview
// questions. Heuristic only — never presented as proof of plagiarism, always
// "High solution similarity detected" / "review recommended" language.
//
// STRICT scoping rule: a candidate's code is only ever compared against
// OTHER candidates who answered the exact same canonical question_id AND
// belong to the SAME organization. Comparing across organizations would leak
// one company's candidate submissions to a competitor — never do that.
// Ad-hoc/generated questions (question_id is null) have no reliable
// comparison group and are skipped outright rather than guessed at.

export type CodeSimilarityLevel = "LOW" | "ELEVATED" | "REVIEW_RECOMMENDED";

const MIN_TOKENS_FOR_ANALYSIS = 25;
const SHINGLE_SIZE = 5;
const MAX_SIBLINGS_COMPARED = 50;
const REVIEW_THRESHOLD = 0.6;
const ELEVATED_THRESHOLD = 0.35;

function tokenize(code: string): string[] {
  const withoutBlockComments = code.replace(/\/\*[\s\S]*?\*\//g, " ");
  const withoutLineComments = withoutBlockComments.replace(/\/\/.*$/gm, " ").replace(/#.*$/gm, " ");
  const matches = withoutLineComments.match(/[A-Za-z_][A-Za-z0-9_]*|[{}()[\];,.]|[+\-*/%=<>!&|]+/g) ?? [];
  return matches.map((token) => token.toLowerCase());
}

function shingles(tokens: string[], size = SHINGLE_SIZE): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i + size <= tokens.length; i += 1) {
    set.add(tokens.slice(i, i + size).join(" "));
  }
  return set;
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const shingle of a) {
    if (b.has(shingle)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function classify(score: number): CodeSimilarityLevel {
  if (score >= REVIEW_THRESHOLD) return "REVIEW_RECOMMENDED";
  if (score >= ELEVATED_THRESHOLD) return "ELEVATED";
  return "LOW";
}

async function ensureCodeSimilaritySchema(): Promise<void> {
  await prisma.$executeRaw`
    alter table public.interview_code_submissions
      add column if not exists similarity_score numeric(5, 2),
      add column if not exists similarity_level text,
      add column if not exists similarity_matched_attempt_id uuid,
      add column if not exists similarity_status text not null default 'pending',
      add column if not exists similarity_checked_at timestamptz
  `;
}

type SiblingRow = { attempt_id: string; code_text: string };

async function loadSiblingSubmissions(
  questionId: string,
  organizationId: string,
  excludeAttemptId: string,
): Promise<SiblingRow[]> {
  return prisma.$queryRaw<SiblingRow[]>`
    select cs.attempt_id, cs.code_text
    from public.interview_code_submissions cs
    inner join public.interview_attempts ia on ia.attempt_id = cs.attempt_id
    inner join public.interviews iv on iv.interview_id = ia.interview_id
    where cs.question_id = ${questionId}::uuid
      and iv.organization_id = ${organizationId}::uuid
      and cs.attempt_id <> ${excludeAttemptId}::uuid
      and cs.code_text is not null
    order by cs.updated_at desc
    limit ${MAX_SIBLINGS_COMPARED}
  `;
}

async function loadOrganizationId(attemptId: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ organization_id: string }[]>`
    select iv.organization_id
    from public.interview_attempts ia
    inner join public.interviews iv on iv.interview_id = ia.interview_id
    where ia.attempt_id = ${attemptId}::uuid
    limit 1
  `;
  return rows[0]?.organization_id ?? null;
}

export async function computeAndPersistCodeSimilarity(params: {
  answerId: string;
  attemptId: string;
  questionId: string | null;
  codeText: string;
}): Promise<void> {
  try {
    await ensureCodeSimilaritySchema();

    if (!params.questionId) {
      // No canonical question to compare against — mark as skipped rather
      // than leaving it stuck at "pending" forever.
      await prisma.$executeRaw`
        update public.interview_code_submissions
        set similarity_status = 'skipped', similarity_checked_at = now()
        where answer_id = ${params.answerId}::uuid
      `;
      return;
    }

    const tokens = tokenize(params.codeText);
    if (tokens.length < MIN_TOKENS_FOR_ANALYSIS) {
      await prisma.$executeRaw`
        update public.interview_code_submissions
        set similarity_status = 'skipped', similarity_checked_at = now()
        where answer_id = ${params.answerId}::uuid
      `;
      return;
    }

    const organizationId = await loadOrganizationId(params.attemptId);
    if (!organizationId) {
      await prisma.$executeRaw`
        update public.interview_code_submissions
        set similarity_status = 'skipped', similarity_checked_at = now()
        where answer_id = ${params.answerId}::uuid
      `;
      return;
    }

    const siblings = await loadSiblingSubmissions(params.questionId, organizationId, params.attemptId);
    const currentShingles = shingles(tokens);

    let bestScore = 0;
    let bestAttemptId: string | null = null;
    for (const sibling of siblings) {
      const siblingTokens = tokenize(sibling.code_text);
      if (siblingTokens.length < MIN_TOKENS_FOR_ANALYSIS) continue;
      const score = jaccardSimilarity(currentShingles, shingles(siblingTokens));
      if (score > bestScore) {
        bestScore = score;
        bestAttemptId = sibling.attempt_id;
      }
    }

    const level = classify(bestScore);

    await prisma.$executeRaw`
      update public.interview_code_submissions
      set similarity_score = ${Math.round(bestScore * 100 * 100) / 100},
          similarity_level = ${level},
          similarity_matched_attempt_id = ${bestAttemptId}::uuid,
          similarity_status = 'checked',
          similarity_checked_at = now()
      where answer_id = ${params.answerId}::uuid
    `;
  } catch (error) {
    console.error("Code similarity check failed", { answerId: params.answerId, error });
  }
}
