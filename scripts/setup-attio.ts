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
  unique?: boolean;
}

const PEOPLE_ATTRIBUTES: AttrDef[] = [
  {
    title: "Telegram",
    api_slug: "telegram",
    type: "text",
  },
  {
    title: "Telegram User ID",
    api_slug: "telegram_user_id",
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

const ASSOCIATION_OBJECT = process.env.TELLATIO_ASSOCIATION_OBJECT || "telegram_associations";
const IDENTITY_OBJECT = process.env.TELLATIO_IDENTITY_OBJECT || "telegram_identities";

const ASSOCIATION_ATTRIBUTES: AttrDef[] = [
  {
    title: "Telegram Chat ID",
    api_slug: "telegram_chat_id",
    type: "text",
    unique: true,
  },
  {
    title: "Telegram Chat Title",
    api_slug: "telegram_chat_title",
    type: "text",
  },
  {
    title: "Telegram Chat Type",
    api_slug: "telegram_chat_type",
    type: "select",
    options: ["dm", "group", "supergroup", "channel", "unknown"],
  },
  {
    title: "Target Object",
    api_slug: "crm_object_slug",
    type: "text",
  },
  {
    title: "Target Name",
    api_slug: "crm_target_name",
    type: "text",
  },
  {
    title: "Target Record ID",
    api_slug: "crm_record_id",
    type: "text",
  },
  {
    title: "Status",
    api_slug: "status",
    type: "select",
    options: ["suggested", "approved", "ignored", "needs_review"],
  },
  {
    title: "Confidence",
    api_slug: "confidence",
    type: "number",
  },
  {
    title: "Reason",
    api_slug: "reason",
    type: "text",
  },
  {
    title: "Sync Mode",
    api_slug: "sync_mode",
    type: "select",
    options: ["transcript", "summary", "stats"],
  },
  {
    title: "Last Observed At",
    api_slug: "last_observed_at",
    type: "timestamp",
  },
];

const IDENTITY_ATTRIBUTES: AttrDef[] = [
  {
    title: "Telegram User ID",
    api_slug: "telegram_user_id",
    type: "text",
    unique: true,
  },
  {
    title: "Telegram Username",
    api_slug: "telegram_username",
    type: "text",
  },
  {
    title: "Telegram Display Name",
    api_slug: "telegram_display_name",
    type: "text",
  },
  {
    title: "Telegram Bio",
    api_slug: "telegram_bio",
    type: "text",
  },
  {
    title: "Company Hints",
    api_slug: "company_hints",
    type: "text",
  },
  {
    title: "Phone",
    api_slug: "phone",
    type: "text",
  },
  {
    title: "Target Name",
    api_slug: "crm_target_name",
    type: "text",
  },
  {
    title: "Target Record ID",
    api_slug: "crm_record_id",
    type: "text",
  },
  {
    title: "Status",
    api_slug: "status",
    type: "select",
    options: ["suggested", "approved", "ignored", "needs_review"],
  },
  {
    title: "Confidence",
    api_slug: "confidence",
    type: "number",
  },
  {
    title: "Reason",
    api_slug: "reason",
    type: "text",
  },
  {
    title: "Last Observed At",
    api_slug: "last_observed_at",
    type: "timestamp",
  },
];

async function ensureObject(objectSlug: string, singularNoun: string, pluralNoun: string): Promise<void> {
  process.stdout.write(`${pluralNoun} object (${objectSlug})... `);
  try {
    const result = await api("POST", "/objects", {
      data: {
        api_slug: objectSlug,
        singular_noun: singularNoun,
        plural_noun: pluralNoun,
      },
    }) as { skipped?: boolean };

    console.log(result?.skipped ? "already exists" : "created");
  } catch (err) {
    console.log(`FAILED: ${err}`);
  }
}

async function ensureAttribute(objectSlug: string, attr: AttrDef): Promise<void> {
  process.stdout.write(`  ${objectSlug}.${attr.title} (${attr.api_slug})... `);
  try {
    const result = await api("POST", `/objects/${objectSlug}/attributes`, {
      data: {
        title: attr.title,
        description: `Managed by Tellatio sync service`,
        api_slug: attr.api_slug,
        type: attr.type,
        is_required: false,
        is_unique: attr.unique || false,
        is_multiselect: false,
        config: {},
      },
    }) as { skipped?: boolean };

    if (result?.skipped) {
      console.log("already exists");
    } else {
      console.log("created");
    }

    if (attr.options) {
      for (const option of attr.options) {
        try {
          await api(
            "POST",
            `/objects/${objectSlug}/attributes/${attr.api_slug}/options`,
            { data: { title: option } },
          );
        } catch {
          // option may already exist
        }
      }
      console.log(`    -> ${attr.options.length} select options ensured`);
    }
  } catch (err) {
    console.log(`FAILED: ${err}`);
  }
}

async function main() {
  console.log("Setting up Attio attributes on People...\n");

  for (const attr of PEOPLE_ATTRIBUTES) {
    await ensureAttribute("people", attr);
  }

  console.log("\nSetting up Telegram Associations object...\n");
  await ensureObject(ASSOCIATION_OBJECT, "Telegram Association", "Telegram Associations");
  for (const attr of ASSOCIATION_ATTRIBUTES) {
    await ensureAttribute(ASSOCIATION_OBJECT, attr);
  }

  console.log("\nSetting up Telegram Identities object...\n");
  await ensureObject(IDENTITY_OBJECT, "Telegram Identity", "Telegram Identities");
  for (const attr of IDENTITY_ATTRIBUTES) {
    await ensureAttribute(IDENTITY_OBJECT, attr);
  }

  console.log("\nDone! Attributes are ready.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
