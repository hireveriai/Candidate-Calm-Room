import assert from "node:assert/strict";
import test from "node:test";

import { buildFallbackCoreQuestion, type InterviewQuestionSource } from "./interviewFlow";
import { resolveRoleContext } from "./roleContext";
import { ROLE_FIXTURES, TECHNICAL_FILLER_PATTERN } from "./roleFixtures.testdata";

const SOURCES: InterviewQuestionSource[] = ["job", "resume", "behavioral"];
const PHASES = ["warmup", "core", "probe"] as const;

function fillersFor(role: (typeof ROLE_FIXTURES)[number]) {
  const context = resolveRoleContext(role);
  const questions: string[] = [];

  for (const sourceType of SOURCES) {
    for (const phase of PHASES) {
      for (let seed = 1; seed <= 12; seed += 1) {
        for (const skillName of role.coreSkills) {
          questions.push(
            buildFallbackCoreQuestion({
              sourceType,
              skillName,
              contextAnchor: role.jobDescription,
              roleTitle: role.jobTitle,
              phase,
              variantSeed: seed,
              roleContext: context.kind,
              roleFamily: context.family,
            })
          );
        }
      }
    }
  }

  return questions;
}

for (const role of ROLE_FIXTURES.filter((fixture) => fixture.expectedKind === "non_technical")) {
  test(`filler: no technical wording for ${role.jobTitle}`, () => {
    for (const question of fillersFor(role)) {
      assert.doesNotMatch(question, TECHNICAL_FILLER_PATTERN, question);
    }
  });
}

test("filler: missing role context never falls back to technical wording", () => {
  for (const sourceType of SOURCES) {
    for (let seed = 1; seed <= 12; seed += 1) {
      const question = buildFallbackCoreQuestion({
        sourceType,
        skillName: "stakeholder management",
        variantSeed: seed,
      });
      assert.doesNotMatch(question, TECHNICAL_FILLER_PATTERN, question);
    }
  }
});

test("filler: technical roles keep the original technical templates", () => {
  for (const role of ROLE_FIXTURES.filter((fixture) => fixture.expectedKind === "technical")) {
    const technicalJobQuestions = fillersFor(role).filter((question) =>
      /in production|degrading|delivery pressure/.test(question)
    );
    assert.ok(technicalJobQuestions.length > 0, role.jobTitle);
  }

  assert.equal(
    buildFallbackCoreQuestion({
      sourceType: "job",
      skillName: "PostgreSQL",
      variantSeed: 1,
      roleContext: "technical",
      roleFamily: "technical",
    }),
    buildFallbackCoreQuestion({
      sourceType: "job",
      skillName: "PostgreSQL",
      variantSeed: 1,
      roleContext: "technical",
    })
  );
});

test("filler: questions are deterministic for the same inputs", () => {
  const input = {
    sourceType: "job" as const,
    skillName: "lesson planning",
    roleTitle: "Teacher",
    variantSeed: 4,
    roleContext: "non_technical" as const,
    roleFamily: "education" as const,
  };
  assert.equal(buildFallbackCoreQuestion(input), buildFallbackCoreQuestion(input));
});

test("filler: role-neutral questions stay anchored to the role's own skill", () => {
  const question = buildFallbackCoreQuestion({
    sourceType: "job",
    skillName: "classroom management",
    variantSeed: 2,
    roleContext: "non_technical",
    roleFamily: "education",
  });
  assert.match(question, /classroom management/);
});

test("filler: closing phase wording is unchanged and role-neutral", () => {
  const question = buildFallbackCoreQuestion({
    sourceType: "job",
    skillName: "renewals",
    phase: "closing",
    roleContext: "non_technical",
    roleFamily: "customer",
  });
  assert.equal(
    question,
    "Before we wrap up, what is one recent decision you made while working on renewals, and why did it matter?"
  );
});
