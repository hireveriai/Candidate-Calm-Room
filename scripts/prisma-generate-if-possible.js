const { existsSync } = require("node:fs");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");

const root = process.cwd();
const generatedClientPath = join(
  root,
  "node_modules",
  ".prisma",
  "client",
  "index.js"
);

function hasGeneratedClient() {
  return existsSync(generatedClientPath);
}

const prismaCmd = process.platform === "win32" ? "npx.cmd" : "npx";
const result = spawnSync(prismaCmd, ["prisma", "generate"], {
  cwd: root,
  stdio: "inherit",
  shell: false,
});

if (result.status === 0) {
  process.exit(0);
}

if (hasGeneratedClient()) {
  console.warn(
    "[prisma-generate-if-possible] prisma generate failed, but an existing generated client was found. Continuing."
  );
  process.exit(0);
}

process.exit(result.status ?? 1);
