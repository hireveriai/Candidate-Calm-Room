import assert from "node:assert/strict";
import { calculateInterviewScore } from "../app/lib/interviewScoring.ts";

const noAnswers = calculateInterviewScore({
  questionsAnswered: 0,
  expectedQuestions: 10,
  avgSkillScore: 1,
  avgCognitiveScore: 1,
  avgFraudScore: 0,
});

assert.equal(noAnswers.finalScore, 0);

const threeOfEightPerfect = calculateInterviewScore({
  questionsAnswered: 3,
  expectedQuestions: 8,
  avgSkillScore: 1,
  avgCognitiveScore: 1,
  avgFraudScore: 0,
});

assert.equal(threeOfEightPerfect.completionPercentage, 0.375);
assert.equal(threeOfEightPerfect.finalScore, 37.5);

const threeOfTenPerfect = calculateInterviewScore({
  questionsAnswered: 3,
  expectedQuestions: 10,
  avgSkillScore: 1,
  avgCognitiveScore: 1,
  avgFraudScore: 0,
});

assert.equal(threeOfTenPerfect.completionPercentage, 0.3);
assert.equal(threeOfTenPerfect.finalScore, 30);

const fullStrongInterview = calculateInterviewScore({
  questionsAnswered: 10,
  expectedQuestions: 10,
  avgSkillScore: 0.8,
  avgCognitiveScore: 0.8,
  avgFraudScore: 0,
});

assert.equal(fullStrongInterview.finalScore, 80);

console.log("Interview scoring policy checks passed.");
