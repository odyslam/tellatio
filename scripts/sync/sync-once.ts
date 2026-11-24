// One-shot forced sync. Mirrors src/sync/main.ts main() but runs a single runSync
// cycle and exits (no interval loop). Honors env overrides for
// TELLATIO_SYNC_SOURCE / TELEGRAM_FOLDER_NAME / DATA_DIR passed on the CLI.
import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "../../src/sync/config";
import { installProxyFromEnv } from "../../src/shared/proxy";
import { initAttio } from "../../src/integrations/attio/client";
import * as telegram from "../../src/sync/telegram";
import { runSync } from "../../src/sync/runner";

function loadEnv(): void {
  try {
    const envPath = path.resolve(__dirname, "..", "..", ".env");
    const content = fs.readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = value; // CLI/env wins over .env
    }
  } catch {
    // rely on real env
  }
}

async function main(): Promise<void> {
  loadEnv();
  installProxyFromEnv();
  const config = loadConfig();
  console.log(
    `[once] forced sync — source=${config.syncSource} folder="${config.folderName}" dataDir=${config.dataDir}`,
  );
  initAttio(config.attioApiKey);
  await telegram.connect(config);
  try {
    await runSync(config);
  } finally {
    await telegram.disconnect();
  }
  console.log("[once] Done.");
  process.exit(0);
}

main().catch((err) => {
  console.error("[once] Fatal:", err);
  process.exit(1);
});
