/**
 * Offline validation math for AI interview scores and fraud signals.
 *
 * Nothing here touches the database or calls a model: it compares exported AI
 * scores with labels from human reviewers (see scripts/scoring-agreement.mjs).
 * The point is to produce evidence — agreement with humans, and how often each
 * fraud signal is right — instead of assuming the scores are valid.
 */

export const MIN_RELIABLE_SAMPLE = 30;

/** Score bands used for band agreement (kappa); keep in line with recruiter-facing labels. */
export const DEFAULT_SCORE_BANDS = [
  { label: "reject", min: 0 },
  { label: "review", min: 40 },
  { label: "advance", min: 70 },
] as const;

type Band = { label: string; min: number };

function mean(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function pearson(xs: number[], ys: number[]) {
  if (xs.length !== ys.length || xs.length < 2) {
    return null;
  }

  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx = 0;
  let dy = 0;

  for (let i = 0; i < xs.length; i += 1) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }

  return dx === 0 || dy === 0 ? null : num / Math.sqrt(dx * dy);
}

/** Ranks with ties averaged (1-based). */
export function rank(values: number[]) {
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const ranks = new Array<number>(values.length);

  for (let start = 0; start < order.length; ) {
    let end = start;
    while (end + 1 < order.length && order[end + 1].value === order[start].value) {
      end += 1;
    }
    const averageRank = (start + end) / 2 + 1;
    for (let k = start; k <= end; k += 1) {
      ranks[order[k].index] = averageRank;
    }
    start = end + 1;
  }

  return ranks;
}

export function spearman(xs: number[], ys: number[]) {
  return pearson(rank(xs), rank(ys));
}

export function toBand(score: number, bands: readonly Band[] = DEFAULT_SCORE_BANDS) {
  let label = bands[0].label;
  for (const band of bands) {
    if (score >= band.min) {
      label = band.label;
    }
  }
  return label;
}

export function confusionMatrix(truth: string[], predicted: string[], labels: string[]) {
  const matrix = labels.map(() => labels.map(() => 0));

  for (let i = 0; i < truth.length; i += 1) {
    const row = labels.indexOf(truth[i]);
    const col = labels.indexOf(predicted[i]);
    if (row >= 0 && col >= 0) {
      matrix[row][col] += 1;
    }
  }

  return matrix;
}

/** Cohen's kappa: agreement beyond chance. 1 = perfect, 0 = chance level. */
export function cohenKappa(matrix: number[][]) {
  const total = matrix.flat().reduce((sum, value) => sum + value, 0);
  if (total === 0) {
    return null;
  }

  const observed = matrix.reduce((sum, row, i) => sum + row[i], 0) / total;
  const expected = matrix.reduce((sum, row, i) => {
    const rowTotal = row.reduce((a, b) => a + b, 0);
    const colTotal = matrix.reduce((a, r) => a + r[i], 0);
    return sum + (rowTotal * colTotal) / (total * total);
  }, 0);

  return expected === 1 ? null : (observed - expected) / (1 - expected);
}

export type ScorePair = { id: string; human: number; ai: number };

export function scoreAgreement(pairs: ScorePair[], bands: readonly Band[] = DEFAULT_SCORE_BANDS) {
  const human = pairs.map((pair) => pair.human);
  const ai = pairs.map((pair) => pair.ai);
  const errors = pairs.map((pair) => Math.abs(pair.ai - pair.human));
  const labels = bands.map((band) => band.label);
  const matrix = confusionMatrix(
    human.map((score) => toBand(score, bands)),
    ai.map((score) => toBand(score, bands)),
    labels,
  );
  const largestGaps = pairs
    .map((pair) => ({ ...pair, gap: Math.abs(pair.ai - pair.human) }))
    .sort((a, b) => b.gap - a.gap)
    .slice(0, 10);

  return {
    n: pairs.length,
    reliable: pairs.length >= MIN_RELIABLE_SAMPLE,
    pearson: pearson(human, ai),
    spearman: spearman(human, ai),
    meanAbsoluteError: pairs.length ? mean(errors) : null,
    meanBias: pairs.length ? mean(pairs.map((pair) => pair.ai - pair.human)) : null,
    within10Points: pairs.length ? errors.filter((error) => error <= 10).length / pairs.length : null,
    bandLabels: labels,
    bandConfusion: matrix,
    bandKappa: cohenKappa(matrix),
    largestGaps,
  };
}

export type SignalCase = { id: string; fraud: boolean; signals: Record<string, boolean> };

/** Precision/recall per fraud signal against human-confirmed outcomes. */
export function signalBenchmark(cases: SignalCase[]) {
  const names = [...new Set(cases.flatMap((c) => Object.keys(c.signals)))].sort();

  return names.map((name) => {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let tn = 0;

    for (const c of cases) {
      const flagged = Boolean(c.signals[name]);
      if (flagged && c.fraud) tp += 1;
      else if (flagged && !c.fraud) fp += 1;
      else if (!flagged && c.fraud) fn += 1;
      else tn += 1;
    }

    const precision = tp + fp ? tp / (tp + fp) : null;
    const recall = tp + fn ? tp / (tp + fn) : null;
    const f1 = precision !== null && recall !== null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : null;
    const falsePositiveRate = fp + tn ? fp / (fp + tn) : null;

    return { signal: name, tp, fp, fn, tn, precision, recall, f1, falsePositiveRate, positives: tp + fn, flagged: tp + fp };
  });
}
