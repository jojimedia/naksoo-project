import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(rootDir, ".env.local");
const targets = ["production", "preview", "development"];

function parseEnvFile(content) {
  const vars = {};

  for (const line of content.split("\n")) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separator = trimmed.indexOf("=");

    if (separator === -1) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key.startsWith("VERCEL_")) {
      continue;
    }

    vars[key] = value;
  }

  return vars;
}

function runVercel(args, input) {
  execFileSync("npx", ["vercel@latest", ...args], {
    cwd: rootDir,
    input,
    stdio: ["pipe", "inherit", "inherit"],
    env: process.env,
  });
}

const vars = parseEnvFile(readFileSync(envPath, "utf8"));
const keys = Object.keys(vars);

if (keys.length === 0) {
  throw new Error(".env.local에 등록할 환경변수가 없습니다.");
}

console.log(`Syncing ${keys.length} variables to Vercel...`);

for (const key of keys) {
  for (const target of targets) {
    console.log(`- ${key} (${target})`);
    runVercel(["env", "add", key, target, "--force"], vars[key]);
  }
}

console.log("Done. Redeploy production to apply changes.");
