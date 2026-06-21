export type InterviewScoreInput = {
  questionsAnswered: number;
  expectedQuestions: number;
  avgSkillScore: number;
  avgCognitiveScore: number;
  avgFraudScore: number;
};

export type InterviewScoreResult = {
  completionPercentage: number;
  completionFactor: number;
  completionScoreCap: number;
  qualityScore: number;
  integrityMultiplier: number;
  baseScore: number;
  finalScore: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function round(value: number, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function calculateInterviewScore(
  input: InterviewScoreInput
): InterviewScoreResult {
  const questionsAnswered = Math.max(Math.floor(input.questionsAnswered), 0);
  const expectedQuestions = Math.max(Math.floor(input.expectedQuestions), 1);
  const completionPercentage = clamp(
    questionsAnswered / expectedQuestions,
    0,
    1
  );
  const completionFactor = completionPercentage;
  const avgSkillScore = clamp(input.avgSkillScore, 0, 1);
  const avgCognitiveScore = clamp(input.avgCognitiveScore, 0, 1);
  const avgFraudScore = clamp(input.avgFraudScore, 0, 1);
  const qualityScore =
    questionsAnswered > 0
      ? ((avgSkillScore * 0.55) + (avgCognitiveScore * 0.45)) * 100
      : 0;
  const integrityMultiplier = clamp(1 - avgFraudScore * 0.5, 0.5, 1);
  const baseScore = round(clamp(qualityScore * integrityMultiplier, 0, 100));
  const completionScoreCap = round(completionPercentage * 100);
  const finalScore = round(
    clamp(
      Math.min(baseScore * completionFactor, completionScoreCap),
      0,
      100
    )
  );

  return {
    completionPercentage,
    completionFactor,
    completionScoreCap,
    qualityScore,
    integrityMultiplier,
    baseScore,
    finalScore,
  };
}
