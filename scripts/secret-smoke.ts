import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readSecret, requireSecret } from "../src/secret";

const NAME = "SMOKE_SECRET";
const FILE_VAR = `${NAME}_FILE`;

function clearEnv(): void {
  delete process.env[NAME];
  delete process.env[FILE_VAR];
}

// (i) ${NAME}_FILE is read, trimmed, and takes precedence over process.env[NAME].
{
  clearEnv();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "secret-smoke-"));
  const file = path.join(dir, "secret.txt");
  fs.writeFileSync(file, "  file-value\n");
  process.env[NAME] = "env-value";
  process.env[FILE_VAR] = file;
  assert.equal(readSecret(NAME), "file-value", "file value should be read and trimmed");
  assert.equal(requireSecret(NAME), "file-value", "file value should take precedence over env");
  fs.rmSync(dir, { recursive: true, force: true });
}

// (ii) Falls back to process.env[NAME] when no file is set.
{
  clearEnv();
  process.env[NAME] = "env-value";
  assert.equal(readSecret(NAME), "env-value", "should fall back to env var");
  assert.equal(requireSecret(NAME), "env-value", "requireSecret should return env var");
}

// (iii) requireSecret throws when neither is set.
{
  clearEnv();
  assert.equal(readSecret(NAME), undefined, "readSecret should be undefined when nothing set");
  assert.throws(
    () => requireSecret(NAME),
    /Missing required secret: SMOKE_SECRET \(set SMOKE_SECRET or SMOKE_SECRET_FILE\)/,
    "requireSecret should throw when nothing set",
  );
}

clearEnv();
console.log("PASS: secret-smoke — file precedence, env fallback, and require-throw all verified");
