export interface Config {
  telegramApiId: number;
  telegramApiHash: string;
  telegramSession: string;
  attioApiKey: string;
  folderName: string;
  syncSource: "associations" | "folder";
  associationObjectSlug: string;
  identityObjectSlug: string;
  folderFallbackEnabled: boolean;
  autoCreatePeople: boolean;
  autoCreateGroupPeople: boolean;
  chatFetchTimeoutSeconds: number;
  syncIntervalSeconds: number;
  discoveryDialogLimit: number;
  dataDir: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;

  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }

  return value;
}

function optionalBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;

  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`${name} must be true or false`);
}

function loadSyncSource(): "associations" | "folder" {
  const raw = process.env["TELLATIO_SYNC_SOURCE"] || process.env["SYNC_SOURCE"] || "associations";
  if (raw === "associations" || raw === "folder") return raw;
  throw new Error("TELLATIO_SYNC_SOURCE must be either associations or folder");
}

function loadSyncIntervalSeconds(): number {
  if (process.env["SYNC_INTERVAL_SECONDS"]) {
    return optionalInt("SYNC_INTERVAL_SECONDS", 900);
  }

  return optionalInt("SYNC_INTERVAL_MINUTES", 15) * 60;
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
    syncSource: loadSyncSource(),
    associationObjectSlug: process.env["TELLATIO_ASSOCIATION_OBJECT"] || "telegram_associations",
    identityObjectSlug: process.env["TELLATIO_IDENTITY_OBJECT"] || "telegram_identities",
    folderFallbackEnabled: optionalBool("TELLATIO_FOLDER_FALLBACK_ENABLED", false),
    autoCreatePeople: optionalBool("TELLATIO_AUTO_CREATE_PEOPLE", false),
    autoCreateGroupPeople: optionalBool("TELLATIO_AUTO_CREATE_GROUP_PEOPLE", false),
    chatFetchTimeoutSeconds: optionalInt("TELLATIO_CHAT_FETCH_TIMEOUT_SECONDS", 30),
    syncIntervalSeconds: loadSyncIntervalSeconds(),
    discoveryDialogLimit: optionalInt("TELLATIO_DISCOVERY_DIALOG_LIMIT", 200),
    dataDir: process.env["DATA_DIR"] || "/data",
  };
}
