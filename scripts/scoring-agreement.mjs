#!/usr/bin/env node
/**
 * Offline scoring and fraud-signal validation. Reads CSV files only: no
 * database, no network, no model calls.
 *
 * Scores (AI vs human reviewers):
 *   node scripts/scoring-agreement.mjs scores <file.csv>
 *   columns: interview_id,human_score,ai_score   (0-100)
 *
 * Fraud signals (each signal vs a human-confirmed outcome):
 *   node scripts/scoring-agreement.mjs signals <file.csv>
 *   columns: interview_id,confirmed_fraud,<signal>,<signal>,...   (1/0, true/false)
 *
 * Add --json for machine-readable output.
 *
 * Getting the data: have two reviewers score a sample of recorded interviews
 * blind to the AI score (average them, or keep the disagreements to measure
 * human-human agreement first), then join with the AI score exported from
 * interview_results.final_score. Use IDs, not names or emails — the CSV must not
 * contain candidate personal data.
 */
import { readFileSync } from "node:fs";

import { MIN_RELIABLE_SAMPLE, scoreAgreement, signalBenchmark } from "../app/lib/scoringAgreement.ts";

function parseCsv(text) {
  const rows = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split(",").map((cell) => cell.trim().replace(/^"|"$/g, "")));
  const [header, ...body] = rows;
  if (!header) throw new Error("CSV is empty");
  return body.map((cells) => Object.fromEntries(header.map((name, i) => [name.toLowerCase(), cells[i] ?? ""])));
}

function toBool(value) {
  return ["1", "true", "yes", "y"].includes(String(value).toLowerCase());
}

const fmt = (value, digits = 3) => (value === null || value === undefined ? "n/a" : Number(value).toFixed(digits));
const pct = (value) => (value === null || value === undefined ? "n/a" : `${(value * 100).toFixed(1)}%`);

const [mode, file] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const asJson = process.argv.includes("--json");

if (!["scores", "signals"].includes(mode) || !file) {
  console.error("Usage: node scripts/scoring-agreement.mjs <scores|signals> <file.csv> [--json]");
  process.exit(2);
}

const records = parseCsv(readFileSync(file, "utf8"));

if (mode === "scores") {
  const skipped = [];
  const pairs = [];
  for (const row of records) {
    const human = Number(row.human_score);
    const ai = Number(row.ai_score);
    if (row.human_score === "" || row.ai_score === "" || !Number.isFinite(human) || !Number.isFinite(ai)) {
      skipped.push(row.interview_id || "(no id)");
      continue;
    }
    pairs.push({ id: row.interview_id, human, ai });
  }

  const report = scoreAgreement(pairs);
  if (asJson) {
    console.log(JSON.stringify({ ...report, skipped }, null, 2));
    process.exit(0);
  }

  console.log(`Interviews compared: ${report.n}${skipped.length ? ` (skipped ${skipped.length} incomplete rows)` : ""}`);
  if (!report.reliable) {
    console.log(`WARNING: fewer than ${MIN_RELIABLE_SAMPLE} interviews; treat these numbers as anecdotal.`);
  }
  console.log(`Pearson r:            ${fmt(report.pearson)}`);
  console.log(`Spearman rho:         ${fmt(report.spearman)}`);
  console.log(`Mean absolute error:  ${fmt(report.meanAbsoluteError, 1)} points`);
  console.log(`Mean bias (AI-human): ${fmt(report.meanBias, 1)} points`);
  console.log(`Within 10 points:     ${pct(report.within10Points)}`);
  console.log(`Band kappa:           ${fmt(report.bandKappa)}  (bands: ${report.bandLabels.join(" / ")})`);
  console.log("\nBand confusion (rows = human, columns = AI):");
  console.log(["", ...report.bandLabels].map((cell) => cell.padStart(9)).join(""));
  report.bandConfusion.forEach((row, i) => {
    console.log([report.bandLabels[i], ...row.map(String)].map((cell) => cell.padStart(9)).join(""));
  });
  console.log("\nLargest disagreements (review these recordings first):");
  for (const gap of report.largestGaps) {
    console.log(`  ${gap.id}: human ${gap.human}, AI ${gap.ai} (gap ${gap.gap})`);
  }
} else {
  const cases = records.map((row) => {
    const { interview_id: id, confirmed_fraud: fraud, ...signals } = row;
    return {
      id,
      fraud: toBool(fraud),
      signals: Object.fromEntries(Object.entries(signals).map(([name, value]) => [name, toBool(value)])),
    };
  });
  const results = signalBenchmark(cases);
  const positives = cases.filter((c) => c.fraud).length;

  if (asJson) {
    console.log(JSON.stringify({ n: cases.length, positives, signals: results }, null, 2));
    process.exit(0);
  }

  console.log(`Cases: ${cases.length}, confirmed fraud: ${positives}`);
  if (positives < 10 || cases.length < MIN_RELIABLE_SAMPLE) {
    console.log("WARNING: too few cases (or too few confirmed fraud cases) for reliable precision/recall.");
  }
  console.log(["signal", "flagged", "precision", "recall", "F1", "false+ rate"].map((cell) => cell.padEnd(14)).join(""));
  for (const r of results) {
    console.log([r.signal, String(r.flagged), pct(r.precision), pct(r.recall), fmt(r.f1, 2), pct(r.falsePositiveRate)].map((cell) => cell.padEnd(14)).join(""));
  }
}
