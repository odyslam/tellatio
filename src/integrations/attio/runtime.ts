import * as attio from "./client";
import { normalizeAssociationName } from "./association";
import { openState, type StateStore, type RunState } from "../../sync/state";
import { runLocal, requireEnv, connect, disconnect, refreshActiveBanList, dataDirFromEnv } from "../../cli/runtime";

async function runAttio(operation: () => Promise<void>): Promise<unknown> {
  return runLocal(async () => {
    attio.initAttio(requireEnv("ATTIO_API_KEY"));
    await operation();
  });
}

async function runTelegramAndAttio(operation: () => Promise<void>): Promise<unknown> {
  return runLocal(async () => {
    attio.initAttio(requireEnv("ATTIO_API_KEY"));
    try {
      await connect();
      await refreshActiveBanList();
      await operation();
    } finally {
      await disconnect();
    }
  });
}

function openLocalState(): { dataDir: string; store: StateStore } {
  const dataDir = dataDirFromEnv();
  return { dataDir, store: openState(dataDir) };
}

function recordRunState(name: string, run: RunState): void {
  let store: StateStore | undefined;
  try {
    store = openLocalState().store;
    store.setRunState(name, run);
  } catch {
    // Run metadata is useful for doctor, but should not make the primary command fail.
  } finally {
    store?.close();
  }
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed) continue;
    const key = normalizeAssociationName(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }

  return result;
}


export { runAttio, runTelegramAndAttio, openLocalState, recordRunState, compactText, uniqueStrings };
