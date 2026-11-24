import { Api } from "telegram";
import {
  chatDisplayName,
  client,
  connect,
  dialogFolders,
  disconnect,
  flagEnabled,
  loadDialogFilters,
  numFlag,
  out,
  requireEnv
} from "../../cli/runtime";
import { loadConfig } from "../../sync/config";
import type { StateStore } from "../../sync/state";
import * as attio from "./client";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { openLocalState } from "./runtime";
const execFileAsync = promisify(execFile);

// ── doctor ──────────────────────────────────────────────────────

type CheckStatus = "pass" | "fail" | "warn" | "skip";

interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail?: string;
  data?: Record<string, unknown>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function envPresence(): Record<string, boolean> {
  return {
    TELEGRAM_API_ID: Boolean(process.env["TELEGRAM_API_ID"]),
    TELEGRAM_API_HASH: Boolean(process.env["TELEGRAM_API_HASH"]),
    TELEGRAM_SESSION: Boolean(process.env["TELEGRAM_SESSION"]),
    ATTIO_API_KEY: Boolean(process.env["ATTIO_API_KEY"]),
    DATA_DIR: Boolean(process.env["DATA_DIR"]),
  };
}

function envCheck(): DoctorCheck {
  try {
    const config = loadConfig();
    return {
      name: "env",
      status: "pass",
      detail: "required environment is present",
      data: {
        syncSource: config.syncSource,
        folderName: config.folderName,
        banFolderName: config.banFolderName,
        associationObject: config.associationObjectSlug,
        identityObject: config.identityObjectSlug,
        folderFallbackEnabled: config.folderFallbackEnabled,
        autoCreatePeople: config.autoCreatePeople,
        syncIntervalSeconds: config.syncIntervalSeconds,
        discoveryDialogLimit: config.discoveryDialogLimit,
        dataDir: config.dataDir,
      },
    };
  } catch (err) {
    return {
      name: "env",
      status: "fail",
      detail: errorMessage(err),
      data: envPresence(),
    };
  }
}

async function telegramDoctorCheck(): Promise<DoctorCheck> {
  try {
    await connect();
    const me = await client.getMe() as Api.User;
    const filters = dialogFolders(await loadDialogFilters());
    return {
      name: "telegram",
      status: "pass",
      detail: "connected and fetched dialog filters",
      data: {
        id: me.id.toString(),
        username: me.username,
        displayName: chatDisplayName(me),
        folderCount: filters.length,
      },
    };
  } catch (err) {
    return {
      name: "telegram",
      status: "fail",
      detail: errorMessage(err),
    };
  } finally {
    await disconnect();
  }
}

async function attioDoctorCheck(limit: number): Promise<DoctorCheck> {
  try {
    attio.initAttio(requireEnv("ATTIO_API_KEY"));
    const associationObject = process.env["TELLATIO_ASSOCIATION_OBJECT"] || "telegram_associations";
    const identityObject = process.env["TELLATIO_IDENTITY_OBJECT"] || "telegram_identities";
    const associations = await attio.listTelegramAssociations(associationObject, limit);
    const identities = await attio.listTelegramIdentities(identityObject, limit);
    const associationCounts = associations.reduce<Record<string, number>>((acc, association) => {
      acc[association.status] = (acc[association.status] || 0) + 1;
      return acc;
    }, {});
    const identityCounts = identities.reduce<Record<string, number>>((acc, identity) => {
      acc[identity.status] = (acc[identity.status] || 0) + 1;
      return acc;
    }, {});

    // Dead-target scan: an approved association/identity whose CRM target record
    // was deleted or merged in Attio still reports status "approved" but silently
    // stops syncing (the note write 404s or is skipped). Flag those here.
    type TargetRef = { kind: "association" | "identity"; object: string; recordId: string; label: string };
    const refs: TargetRef[] = [];
    for (const association of associations) {
      if (association.status === "approved" && association.targetRecordId && association.targetObject) {
        refs.push({
          kind: "association",
          object: association.targetObject,
          recordId: association.targetRecordId,
          label: association.telegramChatTitle,
        });
      }
    }
    for (const identity of identities) {
      if (identity.status === "approved" && identity.targetRecordId) {
        refs.push({
          kind: "identity",
          object: "people",
          recordId: identity.targetRecordId,
          label: identity.telegramDisplayName || identity.telegramUsername || identity.telegramUserId,
        });
      }
    }

    // Dedupe existence checks by object+recordId, but keep every ref for reporting.
    const uniqueTargets = new Map<string, { object: string; recordId: string }>();
    for (const ref of refs) uniqueTargets.set(`${ref.object}:${ref.recordId}`, { object: ref.object, recordId: ref.recordId });

    const existence = new Map<string, boolean>();
    const entries = [...uniqueTargets.entries()];
    const CONCURRENCY = 8;
    for (let i = 0; i < entries.length; i += CONCURRENCY) {
      const batch = entries.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async ([key, target]) => {
        try {
          existence.set(key, await attio.recordExists(target.object, target.recordId));
        } catch {
          // Unknown error (not a 404) — assume alive so we never false-flag a dead target.
          existence.set(key, true);
        }
      }));
    }

    const deadTargets = refs
      .filter((ref) => existence.get(`${ref.object}:${ref.recordId}`) === false)
      .map((ref) => ({ kind: ref.kind, object: ref.object, recordId: ref.recordId, label: ref.label }));

    return {
      name: "attio",
      status: deadTargets.length > 0 ? "warn" : "pass",
      detail: deadTargets.length > 0
        ? `${deadTargets.length} approved target(s) point to a deleted/merged Attio record — repoint with ${"`"}identities upsert${"`"}/${"`"}associations upsert${"`"}`
        : "queried association and identity objects; all approved targets resolve",
      data: {
        associationObject,
        identityObject,
        associationCounts,
        identityCounts,
        approvedTargetsChecked: uniqueTargets.size,
        deadTargetCount: deadTargets.length,
        deadTargets,
      },
    };
  } catch (err) {
    return {
      name: "attio",
      status: "fail",
      detail: errorMessage(err),
    };
  }
}

function findRailwayTellatio(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findRailwayTellatio(item);
      if (found) return found;
    }
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const text = [
    record.name,
    record.serviceName,
    record.service,
    record.id,
  ].filter((item): item is string => typeof item === "string").join(" ").toLowerCase();

  if (text.includes("tellatio")) return record;

  for (const child of Object.values(record)) {
    const found = findRailwayTellatio(child);
    if (found) return found;
  }

  return undefined;
}

async function railwayDoctorCheck(): Promise<DoctorCheck> {
  try {
    const { stdout } = await execFileAsync("railway", ["service", "status", "--all", "--json"], {
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return {
        name: "railway",
        status: "warn",
        detail: "railway CLI returned non-JSON status output",
        data: { output: stdout.slice(0, 1000) },
      };
    }

    const tellatio = findRailwayTellatio(parsed);
    return {
      name: "railway",
      status: tellatio ? "pass" : "warn",
      detail: tellatio ? "found tellatio service in Railway status" : "railway status succeeded but no tellatio service was identified",
      data: tellatio ? { service: tellatio } : { status: parsed as Record<string, unknown> },
    };
  } catch (err) {
    return {
      name: "railway",
      status: "warn",
      detail: `railway service status unavailable: ${errorMessage(err)}`,
    };
  }
}

function stateDoctorCheck(): DoctorCheck {
  let store: StateStore | undefined;
  try {
    const local = openLocalState();
    store = local.store;
    const chatStates = store.getAllChatStates();
    const latestChat = [...chatStates].sort(
      (a, b) => b.lastSyncedDate.localeCompare(a.lastSyncedDate) || b.lastMessageId - a.lastMessageId,
    )[0];
    const migration = store.getMigrationInfo();

    return {
      name: "state",
      status: migration.legacyJsonReappeared ? "warn" : "pass",
      detail: migration.legacyJsonReappeared
        ? "sync-state.json reappeared after migration — did the old build run? Its writes are ignored."
        : "loaded local sync state",
      data: {
        dataDir: local.dataDir,
        dbPath: migration.dbPath,
        schemaVersion: migration.schemaVersion,
        jsonMigrated: migration.jsonMigrated,
        chatCount: chatStates.length,
        latestChat,
        runs: store.getAllRuns(),
      },
    };
  } catch (err) {
    return {
      name: "state",
      status: "warn",
      detail: errorMessage(err),
    };
  } finally {
    store?.close();
  }
}

async function cmdDoctor(flags: Record<string, string>): Promise<void> {
  const checks: DoctorCheck[] = [envCheck()];
  const limit = numFlag(flags, "limit", 500);

  if (!flagEnabled(flags, "skip-telegram")) {
    checks.push(await telegramDoctorCheck());
  } else {
    checks.push({ name: "telegram", status: "skip" });
  }

  if (!flagEnabled(flags, "skip-attio")) {
    checks.push(await attioDoctorCheck(limit));
  } else {
    checks.push({ name: "attio", status: "skip" });
  }

  if (!flagEnabled(flags, "skip-railway")) {
    checks.push(await railwayDoctorCheck());
  } else {
    checks.push({ name: "railway", status: "skip" });
  }

  checks.push(stateDoctorCheck());

  const overall = checks.some((check) => check.status === "fail")
    ? "fail"
    : checks.some((check) => check.status === "warn")
      ? "warn"
      : "pass";

  out({ overall, checks });
}

export { cmdDoctor };
