import { config } from "dotenv";

config({ path: ".env" });
config({ path: ".env.local", override: true });

import { assertUuid } from "../app/lib/interviewReliability";
import { prisma } from "../app/lib/prisma";
import { repairPendingAnswersFromRecording } from "../app/lib/recordingTranscriptRepair";

type AnswerSnapshot = {
  answer_id: string;
  question_order: number | null;
  answer_len: number;
};

async function loadSnapshot(attemptId: string) {
  return prisma.$queryRaw<AnswerSnapshot[]>`
    select
      ans.answer_id::text,
      sq.question_order,
      length(coalesce(ans.answer_text, '')) as answer_len
    from public.interview_answers ans
    left join public.session_questions sq
      on sq.session_question_id = ans.session_question_id
    where ans.attempt_id = ${attemptId}::uuid
    order by sq.question_order asc nulls last
  `;
}

async function main() {
  const attemptId = assertUuid(process.argv[2], "attemptId");
  const apply = process.argv.includes("--apply");

  if (!apply) {
    throw new Error(
      "This is mutation-capable and force-bypasses the incomplete-answer heuristic. Re-run with an exact attempt UUID and --apply."
    );
  }

  const before = await loadSnapshot(attemptId);
  const result = await repairPendingAnswersFromRecording(attemptId, { force: true });
  const after = await loadSnapshot(attemptId);

  console.log(
    JSON.stringify(
      {
        attemptId,
        result,
        before,
        after,
      },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined);
  });
