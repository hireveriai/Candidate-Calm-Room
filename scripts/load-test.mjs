#!/usr/bin/env node
/**
 * HTTP load test for a STAGING deployment. Dependency-free (Node 18+ fetch).
 *
 *   node scripts/load-test.mjs --base https://staging-interview.example.com \
 *     --path /api/health --concurrency 25 --duration 60 --p95-budget-ms 1500
 *
 * Options
 *   --base URL             deployment to test (required)
 *   --path PATH            request path; repeat for several (default /api/health)
 *   --concurrency N        parallel virtual users (default 10, max 500)
 *   --duration SECONDS     how long to run (default 30)
 *   --ramp SECONDS         start users gradually over this time (default 5)
 *   --timeout-ms MS        per-request timeout (default 15000)
 *   --p95-budget-ms MS     exit 1 if any path's p95 is above this
 *   --max-error-rate R     exit 1 if errors/requests is above R (default 0.01)
 *   --header "Name: value" extra header, e.g. a staging session cookie
 *   --json                 print the report as JSON
 *
 * Safety: refuses production hosts (verisnova.com, hireveri.com) unless
 * --allow-production is passed; the default path only reads. It does not create
 * interviews or call AI providers, so it costs nothing beyond hosting. Point
 * --path at AI-backed routes only on staging, with staging API keys and budgets.
 */
const PRODUCTION_HOST = /(^|\.)(verisnova|hireveri)\.com$/i;

function parseArgs(argv) {
  const options = { paths: [], headers: {}, concurrency: 10, duration: 30, ramp: 5, timeoutMs: 15000, maxErrorRate: 0.01 };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };

    if (arg === "--base") options.base = next();
    else if (arg === "--path") options.paths.push(next());
    else if (arg === "--concurrency") options.concurrency = Number(next());
    else if (arg === "--duration") options.duration = Number(next());
    else if (arg === "--ramp") options.ramp = Number(next());
    else if (arg === "--timeout-ms") options.timeoutMs = Number(next());
    else if (arg === "--p95-budget-ms") options.p95BudgetMs = Number(next());
    else if (arg === "--max-error-rate") options.maxErrorRate = Number(next());
    else if (arg === "--header") {
      const raw = next();
      const separator = raw.indexOf(":");
      if (separator <= 0) throw new Error(`Bad header: ${raw}`);
      options.headers[raw.slice(0, separator).trim()] = raw.slice(separator + 1).trim();
    } else if (arg === "--allow-production") options.allowProduction = true;
    else if (arg === "--json") options.json = true;
    else throw new Error(`Unknown option ${arg}`);
  }

  if (!options.paths.length) options.paths.push("/api/health");
  return options;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!options.base) throw new Error("--base is required");
  const base = new URL(options.base);
  if (PRODUCTION_HOST.test(base.hostname) && !options.allowProduction) {
    throw new Error(`${base.hostname} looks like production. Load-test staging instead, or pass --allow-production deliberately.`);
  }
  if (!(options.concurrency >= 1 && options.concurrency <= 500)) throw new Error("--concurrency must be 1-500");
  if (!(options.duration > 0)) throw new Error("--duration must be positive");

  const stats = new Map(options.paths.map((path) => [path, { latencies: [], statuses: {}, errors: 0, failures: {} }]));
  const startedAt = Date.now();
  const endsAt = startedAt + options.duration * 1000;
  let cursor = 0;

  async function user(index) {
    const ramp = Math.min(options.ramp, options.duration / 2);
    const delay = options.concurrency > 1 ? (ramp * 1000 * index) / (options.concurrency - 1) : 0;
    await new Promise((resolve) => setTimeout(resolve, delay));

    while (Date.now() < endsAt) {
      const path = options.paths[cursor++ % options.paths.length];
      const entry = stats.get(path);
      const t0 = performance.now();
      try {
        const response = await fetch(new URL(path, base), {
          headers: { "user-agent": "verisnova-load-test/1.0", ...options.headers },
          signal: AbortSignal.timeout(options.timeoutMs),
        });
        await response.arrayBuffer();
        entry.latencies.push(performance.now() - t0);
        entry.statuses[response.status] = (entry.statuses[response.status] ?? 0) + 1;
        if (response.status >= 500 || response.status === 429) entry.errors += 1;
      } catch (error) {
        entry.latencies.push(performance.now() - t0);
        entry.errors += 1;
        const name = error?.name === "TimeoutError" ? "timeout" : error?.cause?.code || error?.name || "error";
        entry.failures[name] = (entry.failures[name] ?? 0) + 1;
      }
    }
  }

  await Promise.all(Array.from({ length: options.concurrency }, (_, index) => user(index)));
  const elapsedSeconds = (Date.now() - startedAt) / 1000;

  let failed = false;
  const report = {
    base: base.origin,
    concurrency: options.concurrency,
    durationSeconds: Number(elapsedSeconds.toFixed(1)),
    paths: [...stats].map(([path, entry]) => {
      const sorted = [...entry.latencies].sort((a, b) => a - b);
      const requests = sorted.length;
      const errorRate = requests ? entry.errors / requests : 1;
      const p95 = percentile(sorted, 95);
      const overBudget = options.p95BudgetMs !== undefined && (p95 === null || p95 > options.p95BudgetMs);
      if (overBudget || errorRate > options.maxErrorRate) failed = true;

      return {
        path,
        requests,
        rps: Number((requests / elapsedSeconds).toFixed(1)),
        errorRate: Number(errorRate.toFixed(4)),
        p50Ms: Math.round(percentile(sorted, 50) ?? 0),
        p95Ms: Math.round(p95 ?? 0),
        p99Ms: Math.round(percentile(sorted, 99) ?? 0),
        maxMs: Math.round(sorted.at(-1) ?? 0),
        statuses: entry.statuses,
        failures: entry.failures,
        overBudget,
      };
    }),
  };
  report.passed = !failed;

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`${report.base}  ${report.concurrency} users  ${report.durationSeconds}s`);
    for (const p of report.paths) {
      console.log(`\n${p.path}`);
      console.log(`  requests ${p.requests}  (${p.rps}/s)  errors ${(p.errorRate * 100).toFixed(2)}%`);
      console.log(`  latency p50 ${p.p50Ms}ms  p95 ${p.p95Ms}ms  p99 ${p.p99Ms}ms  max ${p.maxMs}ms${p.overBudget ? "  OVER BUDGET" : ""}`);
      console.log(`  statuses ${JSON.stringify(p.statuses)}${Object.keys(p.failures).length ? `  failures ${JSON.stringify(p.failures)}` : ""}`);
    }
    console.log(`\n${report.passed ? "PASS" : "FAIL"}`);
  }

  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 2;
});
