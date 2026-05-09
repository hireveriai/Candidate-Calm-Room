const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const reportPath = path.join(repoRoot, "production-validation-report.json");
const defaultPort = Number(process.env.HIREVERI_VALIDATION_PORT || 3114);
const baseUrl = process.env.HIREVERI_BASE_URL || `http://127.0.0.1:${defaultPort}`;
const logPath = path.join(repoRoot, `production-validation-${defaultPort}.log`);
const seedPath = path.join(repoRoot, "codex-e2e-seed.json");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  let json = null;

  try {
    json = text ? JSON.parse(text) : null;
  } catch (_error) {
    json = null;
  }

  return {
    ok: response.ok,
    status: response.status,
    text,
    json,
  };
}

function runBuild() {
  if (process.env.HIREVERI_SKIP_BUILD === "1") {
    return;
  }

  const result = spawnSync("npm", ["run", "build"], {
    cwd: repoRoot,
    stdio: "inherit",
    shell: true,
  });

  if (result.status !== 0) {
    throw new Error(`npm run build failed with exit code ${result.status}`);
  }
}

async function waitForHealth(url, timeoutMs = 120000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetchJson(`${url}/api/health`);
      if (response.status > 0) {
        return response;
      }
    } catch (_error) {
      // Server may still be booting.
    }

    await sleep(2000);
  }

  throw new Error("Timed out waiting for /api/health");
}

function startServer() {
  if (process.env.HIREVERI_SKIP_START === "1") {
    return null;
  }

  if (fs.existsSync(logPath)) {
    fs.unlinkSync(logPath);
  }

  const child = spawn(
    "cmd.exe",
    ["/c", `npm run start -- --port ${defaultPort} > "${logPath}" 2>&1`],
    {
      cwd: repoRoot,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }
  );

  child.unref();
  return child.pid;
}

async function main() {
  const validation = {
    generatedAt: new Date().toISOString(),
    baseUrl,
    build: { ok: false },
    runtime: { ok: false, pid: null },
    routes: {},
    database: { ok: false },
    websocket: { ok: false },
    calmRoom: { ok: false, token: null, status: null },
    warnings: [],
  };

  runBuild();
  validation.build.ok = true;

  const pid = startServer();
  validation.runtime.pid = pid;

  const healthResponse = await waitForHealth(baseUrl);
  validation.runtime.ok = healthResponse.status > 0;
  validation.runtime.status = healthResponse.status;
  validation.database = healthResponse.json?.database ?? { ok: false };
  validation.warnings = healthResponse.json?.warnings ?? [];

  const routeChecks = [
    "/",
    "/api/health",
    "/api/test",
  ];

  for (const route of routeChecks) {
    const response = await fetchJson(`${baseUrl}${route}`);
    validation.routes[route] = {
      ok: response.ok,
      status: response.status,
    };
  }

  const liveKitTokenResponse = await fetchJson(
    `${baseUrl}/api/livekit/token?room=validation-room&userId=validation-user&role=publisher`
  );
  validation.websocket = {
    ok: liveKitTokenResponse.ok && Boolean(liveKitTokenResponse.json?.token),
    status: liveKitTokenResponse.status,
  };

  if (fs.existsSync(seedPath)) {
    const seed = JSON.parse(fs.readFileSync(seedPath, "utf8"));
    const token = seed?.candidateA?.token ?? null;
    if (token) {
      const response = await fetch(`${baseUrl}/interview/${token}`, {
        redirect: "manual",
      });
      validation.calmRoom = {
        ok: response.status >= 200 && response.status < 400,
        token,
        status: response.status,
      };
    }
  }

  fs.writeFileSync(reportPath, JSON.stringify(validation, null, 2));
  console.log(JSON.stringify(validation, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
