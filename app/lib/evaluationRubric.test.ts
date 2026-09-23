import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEvaluationRubric,
  deriveSkillType,
  resolveAnswerEvaluationPlan,
  ROLE_NEUTRAL_QUESTION_TYPE_LABEL,
  ROLE_NEUTRAL_RUBRIC,
} from "./evaluationRubric";
import {
  classifyInterviewQuestion,
  InterviewQuestionType,
  normalizeInterviewQuestionType,
} from "./interviewQuestionTypes";
import { ROLE_FIXTURES } from "./roleFixtures.testdata";

const TECHNICAL_RUBRIC_PATTERN =
  /technical depth|architecture|scalability|debugging|platform maturity|data flow|syntax/i;

/** The inline logic the routes used before this change. */
function previousQuestionType(storedType: string | null, question: string, jobTitle: string) {
  return normalizeInterviewQuestionType(
    storedType,
    classifyInterviewQuestion(question, jobTitle, []).questionType
  );
}

for (const role of ROLE_FIXTURES) {
  // Questionnaire questions are stored as "open_ended"; an unlinked answer
  // previously fell back to the session question kind "core".
  for (const storedType of ["open_ended", "core", null]) {
    test(`scoring: ${role.jobTitle} open-ended question (${storedType ?? "no stored type"})`, () => {
      const plan = resolveAnswerEvaluationPlan({
        storedQuestionType: storedType,
        questionText: role.sampleQuestion,
        sourceType: "job",
        jobTitle: role.jobTitle,
        jobDescription: role.jobDescription,
        coreSkills: role.coreSkills,
      });

      if (role.expectedKind === "technical") {
        // Technical roles resolve exactly as before.
        const before = previousQuestionType(storedType, role.sampleQuestion, role.jobTitle);
        assert.equal(plan.questionType, before);
        assert.equal(plan.rubric, buildEvaluationRubric(before));
        assert.equal(plan.rubricSource, "question_type");
      } else {
        assert.doesNotMatch(plan.rubric, TECHNICAL_RUBRIC_PATTERN, plan.rubric);
        assert.notEqual(plan.questionTypeLabel, InterviewQuestionType.TECHNICAL_DISCUSSION);
        assert.notEqual(plan.questionTypeLabel, InterviewQuestionType.ARCHITECTURE);
        assert.notEqual(plan.questionTypeLabel, InterviewQuestionType.SYSTEM_DESIGN);
        assert.notEqual(plan.skillType, "technical");
      }
    });
  }
}

test("scoring: the previous default really was technical for non-technical roles", () => {
  // Guards the premise of the fix: without the role-aware plan, a teacher's
  // open-ended question resolves to the technical discussion rubric.
  const teacher = ROLE_FIXTURES.find((role) => role.jobTitle === "Teacher")!;
  const before = previousQuestionType("open_ended", teacher.sampleQuestion, teacher.jobTitle);
  assert.equal(before, InterviewQuestionType.TECHNICAL_DISCUSSION);
  assert.match(buildEvaluationRubric(before), /technical depth/);
});

test("scoring: strategy and 'how would you build' wording no longer pull architecture rubrics for non-technical roles", () => {
  const product = resolveAnswerEvaluationPlan({
    storedQuestionType: "open_ended",
    questionText: "How would you build a roadmap when sales and engineering want different things?",
    jobTitle: "Product Manager",
  });
  assert.equal(product.rubric, ROLE_NEUTRAL_RUBRIC);
  assert.equal(product.questionTypeLabel, ROLE_NEUTRAL_QUESTION_TYPE_LABEL);

  const strategy = resolveAnswerEvaluationPlan({
    storedQuestionType: "open_ended",
    questionText: "What is your strategy when a campaign is underperforming?",
    jobTitle: "Marketing Strategy Manager",
  });
  assert.equal(strategy.rubric, ROLE_NEUTRAL_RUBRIC);
});

test("scoring: technical roles can still receive architecture and system design rubrics", () => {
  const design = resolveAnswerEvaluationPlan({
    storedQuestionType: "open_ended",
    questionText: "How would you build a scalable notification service?",
    jobTitle: "Senior Software Engineer",
  });
  assert.equal(design.questionType, InterviewQuestionType.SYSTEM_DESIGN);
  assert.equal(design.rubric, buildEvaluationRubric(InterviewQuestionType.SYSTEM_DESIGN));

  const troubleshooting = resolveAnswerEvaluationPlan({
    storedQuestionType: null,
    questionText: "What would you check first when replication lag suddenly spikes?",
    jobTitle: "Database Administrator",
  });
  assert.equal(troubleshooting.questionType, InterviewQuestionType.TROUBLESHOOTING);
  assert.match(troubleshooting.rubric, /debugging methodology/);
});

test("scoring: legacy emergency rows stored as technical_discussion are neutralised for non-technical roles", () => {
  const plan = resolveAnswerEvaluationPlan({
    storedQuestionType: "technical_discussion",
    questionText: "How do you coordinate stakeholders when onboarding priorities conflict?",
    jobTitle: "Customer Success Manager",
  });
  assert.equal(plan.rubric, ROLE_NEUTRAL_RUBRIC);
});

test("scoring: behavioural, case study and explicit coding rubrics are kept for every role", () => {
  const behavioural = resolveAnswerEvaluationPlan({
    storedQuestionType: "behavioral",
    questionText: "Tell me about a time you handled conflict in your team.",
    jobTitle: "Teacher",
  });
  assert.equal(behavioural.rubric, buildEvaluationRubric(InterviewQuestionType.BEHAVIORAL));
  assert.equal(behavioural.skillType, "behavioral");

  const caseStudy = resolveAnswerEvaluationPlan({
    storedQuestionType: "case_study",
    questionText: "Walk me through this client escalation scenario.",
    jobTitle: "Operations Manager",
  });
  assert.equal(caseStudy.rubric, buildEvaluationRubric(InterviewQuestionType.CASE_STUDY));

  const coding = resolveAnswerEvaluationPlan({
    storedQuestionType: "coding",
    questionText: "Write a function that validates an API payload.",
    jobTitle: "Software Engineer",
  });
  assert.equal(coding.rubric, buildEvaluationRubric(InterviewQuestionType.CODING));
});

test("scoring: stored evaluation criteria and competency are carried for every role", () => {
  for (const role of ROLE_FIXTURES) {
    const plan = resolveAnswerEvaluationPlan({
      storedQuestionType: "open_ended",
      questionText: role.sampleQuestion,
      jobTitle: role.jobTitle,
      evaluationCriteria: `  ${role.sampleCriteria}  `,
      competencyLabel: "Judgement",
    });
    assert.equal(plan.evaluationCriteria, role.sampleCriteria);
    assert.equal(plan.competency, "Judgement");
  }
});

test("scoring: missing criteria stays null so the payload is unchanged", () => {
  const plan = resolveAnswerEvaluationPlan({ questionText: "How do you plan your week?", jobTitle: "Teacher" });
  assert.equal(plan.evaluationCriteria, null);
  assert.equal(plan.competency, null);
});

test("skill type: non-technical roles never get technical follow-up handling", () => {
  assert.equal(deriveSkillType("job", "performance management", null, "non_technical"), "functional");
  assert.equal(deriveSkillType("job", "backup planning", null, "non_technical"), "functional");
  assert.equal(deriveSkillType("behavioral", "sql", null, "non_technical"), "behavioral");
});

test("skill type: technical roles and callers without context behave as before", () => {
  assert.equal(deriveSkillType("job", "postgresql", null, "technical"), "technical");
  assert.equal(deriveSkillType("job", "postgresql"), "technical");
  assert.equal(deriveSkillType("job", "negotiation"), "functional");
  assert.equal(deriveSkillType("job", "sql", InterviewQuestionType.BEHAVIORAL), "behavioral");
});
