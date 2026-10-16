import assert from "node:assert/strict";
import test from "node:test";

import {
  cohenKappa,
  confusionMatrix,
  pearson,
  rank,
  scoreAgreement,
  signalBenchmark,
  spearman,
  toBand,
} from "@/app/lib/scoringAgreement";

const close = (actual: number | null, expected: number, epsilon = 1e-9) =>
  assert.ok(actual !== null && Math.abs(actual - expected) < epsilon, `${actual} != ${expected}`);

test("pearson detects perfect, inverse and undefined correlation", () => {
  close(pearson([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  close(pearson([1, 2, 3, 4], [4, 3, 2, 1]), -1);
  assert.equal(pearson([1, 1, 1], [1, 2, 3]), null, "constant series has no correlation");
  assert.equal(pearson([1], [1]), null);
});

test("ranks average ties and spearman ignores scale", () => {
  assert.deepEqual(rank([10, 20, 20, 30]), [1, 2.5, 2.5, 4]);
  close(spearman([1, 2, 3, 4], [1, 4, 9, 16]), 1);
});

test("scores map to bands at the thresholds", () => {
  assert.equal(toBand(0), "reject");
  assert.equal(toBand(39.9), "reject");
  assert.equal(toBand(40), "review");
  assert.equal(toBand(70), "advance");
});

test("kappa matches a worked example", () => {
  // Classic 2x2 example: observed 0.7, expected 0.5 → kappa 0.4.
  close(cohenKappa([[20, 5], [10, 15]]), 0.4);
  close(cohenKappa(confusionMatrix(["a", "b"], ["a", "b"], ["a", "b"])), 1);
  assert.equal(cohenKappa([[0, 0], [0, 0]]), null);
});

test("score agreement reports error, bias, small-sample warning and largest gaps", () => {
  const report = scoreAgreement([
    { id: "a", human: 80, ai: 85 },
    { id: "b", human: 30, ai: 50 },
    { id: "c", human: 60, ai: 60 },
  ]);

  assert.equal(report.n, 3);
  assert.equal(report.reliable, false);
  close(report.meanAbsoluteError, 25 / 3);
  close(report.meanBias, 25 / 3);
  close(report.within10Points, 2 / 3);
  assert.equal(report.largestGaps[0].id, "b");
  assert.deepEqual(report.bandConfusion, [[0, 1, 0], [0, 1, 0], [0, 0, 1]]);
});

test("signal benchmark computes precision and recall per signal", () => {
  const [gaze, tab] = signalBenchmark([
    { id: "1", fraud: true, signals: { gaze: true, tab: false } },
    { id: "2", fraud: true, signals: { gaze: true, tab: true } },
    { id: "3", fraud: false, signals: { gaze: true, tab: false } },
    { id: "4", fraud: false, signals: { gaze: false, tab: false } },
  ]);

  assert.equal(gaze.signal, "gaze");
  close(gaze.precision, 2 / 3);
  close(gaze.recall, 1);
  close(gaze.falsePositiveRate, 0.5);
  assert.equal(tab.signal, "tab");
  close(tab.precision, 1);
  close(tab.recall, 0.5);
});
