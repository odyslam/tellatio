export interface Config {
  telegramApiId: number;
  telegramApiHash: string;
  telegramSession: string;
  attioApiKey: string;
  folderName: string;
  syncIntervalSeconds: number;
  dataDir: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function loadConfig(): Config {
  const apiId = Number.parseInt(requireEnv("TELEGRAM_API_ID"), 10);
  if (!Number.isFinite(apiId)) {
    throw new Error("TELEGRAM_API_ID must be a number");
  }

  return {
    telegramApiId: apiId,
    telegramApiHash: requireEnv("TELEGRAM_API_HASH"),
    telegramSession: requireEnv("TELEGRAM_SESSION"),
    attioApiKey: requireEnv("ATTIO_API_KEY"),
    folderName: process.env["TELEGRAM_FOLDER_NAME"] || "Attio",
    syncIntervalSeconds: Number.parseInt(process.env["SYNC_INTERVAL_SECONDS"] || "900", 10),
    dataDir: process.env["DATA_DIR"] || "/data",
  };
}
