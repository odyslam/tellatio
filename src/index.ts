import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "./config";
import { initAttio } from "./attio";
import * as telegram from "./telegram";
import { runSync } from "./sync";

// Load .env from project root (no dotenv dependency)
function loadEnv(): void {
  try {
    const envPath = path.resolve(__dirname, "..", ".env");
    const content = fs.readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // no .env, rely on actual env vars
  }
}

async function main(): Promise<void> {
  loadEnv();
  console.log("Tellatio — Telegram → Attio Sync Service");

  const config = loadConfig();
  initAttio(config.attioApiKey);

  await telegram.connect(config);

  // Run once immediately
  await runSync(config);

  // Then run on interval
  const intervalMs = config.syncIntervalSeconds * 1000;
  console.log(`[main] Next sync in ${config.syncIntervalSeconds}s`);

  const timer = setInterval(async () => {
    try {
      await runSync(config);
    } catch (err) {
      console.error("[main] Sync error:", err);
    }
    console.log(`[main] Next sync in ${config.syncIntervalSeconds}s`);
  }, intervalMs);

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\n[main] Shutting down...");
    clearInterval(timer);
    await telegram.disconnect();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[main] Fatal error:", err);
  process.exit(1);
});
