/**
 * One-time setup: create the required custom attributes on People in Attio.
 * Run: npx ts-node scripts/setup-attio.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";

// Load .env
const envPath = path.resolve(__dirname, "..", ".env");
try {
  const content = fs.readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
} catch {}

const API_KEY = process.env.ATTIO_API_KEY;
if (!API_KEY) {
  console.error("ATTIO_API_KEY not set");
  process.exit(1);
}

const BASE = "https://api.attio.com/v2";

async function api(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json();
  if (!res.ok) {
    const err = data as { code?: string; message?: string };
    // 409 = already exists, that's fine
    if (res.status === 409) {
      return { skipped: true, code: err.code };
    }
    throw new Error(`${res.status} ${err.code}: ${err.message}`);
  }
  return data;
}

interface AttrDef {
  title: string;
  api_slug: string;
  type: string;
  options?: string[];
}

const ATTRIBUTES: AttrDef[] = [
  {
    title: "Telegram",
    api_slug: "telegram",
    type: "text",
  },
  {
    title: "Telegram Connection",
    api_slug: "telegram_connection",
    type: "select",
    options: ["No Connection", "Very Weak", "Weak", "Good", "Strong", "Very Strong"],
  },
  {
    title: "Telegram First Interaction",
    api_slug: "telegram_first_interaction",
    type: "date",
  },
  {
    title: "Telegram Last Interaction",
    api_slug: "telegram_last_interaction",
    type: "date",
  },
  {
    title: "Telegram Message Count",
    api_slug: "telegram_message_count",
    type: "number",
  },
];

async function main() {
  console.log("Setting up Attio attributes on People...\n");

  for (const attr of ATTRIBUTES) {
    process.stdout.write(`  ${attr.title} (${attr.api_slug})... `);
    try {
      const result = await api("POST", "/objects/people/attributes", {
        data: {
          title: attr.title,
          description: `Managed by Tellatio sync service`,
          api_slug: attr.api_slug,
          type: attr.type,
          is_required: false,
          is_unique: false,
          is_multiselect: false,
          config: {},
        },
      }) as { skipped?: boolean };

      if (result?.skipped) {
        console.log("already exists");
      } else {
        console.log("created");
      }

      // Create select options if needed
      if (attr.options) {
        for (const option of attr.options) {
          try {
            const optResult = await api(
              "POST",
              `/objects/people/attributes/${attr.api_slug}/options`,
              { data: { title: option } },
            ) as { skipped?: boolean };
            if (optResult?.skipped) {
              // already exists
            }
          } catch (err) {
            // option may already exist
          }
        }
        console.log(`    → ${attr.options.length} select options ensured`);
      }
    } catch (err) {
      console.log(`FAILED: ${err}`);
    }
  }

  console.log("\nDone! Attributes are ready.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
