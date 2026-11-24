import { Cli, z } from "incur";
import { commandFlags, runLocal, runTelegram } from "../../cli/runtime";
import { runAttio, runTelegramAndAttio } from "./runtime";
import { cmdDoctor } from "./doctor";
import { cmdFoldersSyncAttio, cmdDiscoverAssociations, cmdAssociationsUpsert, cmdAssociationsReconcile, cmdAssociationsStatus, cmdAssociationsCompanyCandidates, cmdIdentitiesReconcile, cmdIdentitiesCandidates, cmdIdentitiesUpsert, cmdIdentitiesStatus } from "./commands";

export const discover = Cli.create("discover", { description: "Find likely Telegram to Attio associations" })
  .command("associations", {
    description: "Dry-run recent chats and propose CRM association candidates",
    options: z.object({
      limit: z.number().default(100).describe("Maximum recent dialogs to inspect"),
      since: z.string().default("3d").describe("Time filter: today, yesterday, Nd, Nh, Nm, or YYYY-MM-DD"),
      includeIgnored: z.boolean().default(false).describe("Include low-confidence ignored candidates"),
      onlyChats: z.string().optional().describe("Comma-separated Telegram canonical chat IDs to restrict scanning"),
    }),
    run: (c) => runTelegram(() => cmdDiscoverAssociations(commandFlags({
      limit: c.options.limit,
      since: c.options.since,
      "include-ignored": c.options.includeIgnored,
      "only-chats": c.options.onlyChats,
    }))),
  });

export const associations = Cli.create("associations", { description: "Manage Attio Telegram association records" })
  .command("status", {
    description: "List Telegram Association records with counts by status",
    options: z.object({
      object: z.string().default("telegram_associations").describe("Attio association object slug"),
      limit: z.number().default(500).describe("Maximum association records to inspect"),
    }),
    run: (c) => runAttio(() => cmdAssociationsStatus(commandFlags({
      object: c.options.object,
      limit: c.options.limit,
    }))),
  })
  .command("company-candidates", {
    description: "Search Attio Company candidates by name (for association approval)",
    options: z.object({
      name: z.string().describe("Company name search"),
    }),
    run: (c) => runAttio(() => cmdAssociationsCompanyCandidates(commandFlags({
      name: c.options.name,
    }))),
  })
  .command("upsert", {
    description: "Create or update a Telegram Association record in Attio",
    options: z.object({
      object: z.string().default("telegram_associations").describe("Attio association object slug"),
      chatId: z.string().describe("Telegram chat ID from discover associations"),
      title: z.string().describe("Telegram chat title"),
      type: z.string().default("unknown").describe("dm, group, supergroup, channel, or unknown"),
      targetObject: z.string().describe("Attio target object slug, for example people or companies"),
      targetName: z.string().optional().describe("Human-readable inferred target name"),
      targetRecordId: z.string().default("").describe("Attio target record ID; required before approval"),
      status: z.string().default("suggested").describe("suggested, approved, ignored, or needs_review"),
      confidence: z.number().default(0).describe("Confidence from 0 to 1"),
      reason: z.string().default("").describe("Short rationale for the association"),
      syncMode: z.string().default("transcript").describe("transcript, summary, or stats"),
      dryRun: z.boolean().default(false).describe("Preview without writing to Attio"),
    }),
    run: (c) => runAttio(() => cmdAssociationsUpsert(commandFlags({
      object: c.options.object,
      "chat-id": c.options.chatId,
      title: c.options.title,
      type: c.options.type,
      "target-object": c.options.targetObject,
      "target-name": c.options.targetName,
      "target-record-id": c.options.targetRecordId,
      status: c.options.status,
      confidence: c.options.confidence,
      reason: c.options.reason,
      "sync-mode": c.options.syncMode,
      "dry-run": c.options.dryRun,
    }))),
  })
  .command("reconcile", {
    description: "Discover chats and propose Attio company destinations for explicit approval",
    options: z.object({
      object: z.string().default("telegram_associations").describe("Attio association object slug"),
      identityObject: z.string().default("telegram_identities").describe("Attio identity object slug"),
      limit: z.number().default(100).describe("Maximum recent dialogs to inspect"),
      since: z.string().default("3d").describe("Time filter: today, yesterday, Nd, Nh, Nm, or YYYY-MM-DD"),
      minConfidence: z.number().default(0.45).describe("Minimum confidence required to upsert a candidate"),
      includeIdentityEvidence: z.boolean().default(true).describe("Use approved Telegram identities and Person email domains as group company evidence"),
      identityParticipantLimit: z.number().default(30).describe("Maximum recent senders or fallback participants to inspect for identity evidence"),
      includeProfileDescriptions: z.boolean().default(true).describe("Use Telegram profile descriptions/bios from group participants as company signals"),
      profileParticipantLimit: z.number().default(30).describe("Maximum group participants to inspect for profile company hints"),
      companyLimit: z.number().default(500).describe("Maximum Attio companies to load for profile hint matching"),
      onlyChats: z.string().optional().describe("Comma-separated Telegram canonical chat IDs to restrict scanning"),
      dryRun: z.boolean().default(false).describe("Preview without writing association records"),
    }),
    run: (c) => runTelegramAndAttio(() => cmdAssociationsReconcile(commandFlags({
      object: c.options.object,
      "identity-object": c.options.identityObject,
      limit: c.options.limit,
      since: c.options.since,
      "min-confidence": c.options.minConfidence,
      "include-identity-evidence": c.options.includeIdentityEvidence,
      "identity-participant-limit": c.options.identityParticipantLimit,
      "include-profile-descriptions": c.options.includeProfileDescriptions,
      "profile-participant-limit": c.options.profileParticipantLimit,
      "company-limit": c.options.companyLimit,
      "only-chats": c.options.onlyChats,
      "dry-run": c.options.dryRun,
    }))),
  });

export const identities = Cli.create("identities", { description: "Resolve Telegram users to existing Attio People" })
  .command("status", {
    description: "List Telegram Identity records with counts by status",
    options: z.object({
      identityObject: z.string().default("telegram_identities").describe("Attio identity object slug"),
      limit: z.number().default(500).describe("Maximum identity records to inspect"),
    }),
    run: (c) => runAttio(() => cmdIdentitiesStatus(commandFlags({
      "identity-object": c.options.identityObject,
      limit: c.options.limit,
    }))),
  })
  .command("reconcile", {
    description: "Scan Telegram identities; approve only stable ID matches and propose profile matches for review",
    options: z.object({
      object: z.string().default("telegram_associations").describe("Attio chat association object slug"),
      identityObject: z.string().default("telegram_identities").describe("Attio identity object slug"),
      limit: z.number().default(100).describe("Maximum recent dialogs to inspect"),
      since: z.string().default("3d").describe("Time filter: today, yesterday, Nd, Nh, Nm, or YYYY-MM-DD"),
      includeParticipants: z.boolean().default(true).describe("Include participants from approved group chats"),
      includeExplicitGroups: z.boolean().default(false).describe("Also include participants from explicit --only-chats group IDs that do not yet have approved associations"),
      includeProfileDescriptions: z.boolean().default(true).describe("Fetch Telegram profile descriptions/bios and infer company hints"),
      groupTitleCompanyHints: z.boolean().default(true).describe("Use explicit group titles as company hints when scanning unassociated groups"),
      participantLimit: z.number().default(50).describe("Maximum recent senders or fallback participants per approved group"),
      companyLimit: z.number().default(500).describe("Maximum Attio companies to load for profile hint matching"),
      onlyChats: z.string().optional().describe("Comma-separated Telegram canonical chat IDs to restrict scanning"),
      dryRun: z.boolean().default(false).describe("Preview without writing identity records or People updates"),
    }),
    run: (c) => runTelegramAndAttio(() => cmdIdentitiesReconcile(commandFlags({
      object: c.options.object,
      "identity-object": c.options.identityObject,
      limit: c.options.limit,
      since: c.options.since,
      "include-participants": c.options.includeParticipants,
      "include-explicit-groups": c.options.includeExplicitGroups,
      "include-profile-descriptions": c.options.includeProfileDescriptions,
      "group-title-company-hints": c.options.groupTitleCompanyHints,
      "participant-limit": c.options.participantLimit,
      "company-limit": c.options.companyLimit,
      "only-chats": c.options.onlyChats,
      "dry-run": c.options.dryRun,
    }))),
  })
  .command("candidates", {
    description: "Search Attio People candidates for a Telegram identity",
    options: z.object({
      name: z.string().optional().describe("Person name search"),
      username: z.string().optional().describe("Telegram username search"),
      phone: z.string().optional().describe("Phone number search"),
      telegramUserId: z.string().optional().describe("Telegram user ID search"),
    }),
    run: (c) => runAttio(() => cmdIdentitiesCandidates(commandFlags({
      name: c.options.name,
      username: c.options.username,
      phone: c.options.phone,
      "telegram-user-id": c.options.telegramUserId,
    }))),
  })
  .command("upsert", {
    description: "Create or update a manual Telegram user to Attio Person mapping",
    options: z.object({
      identityObject: z.string().default("telegram_identities").describe("Attio identity object slug"),
      telegramUserId: z.string().describe("Stable Telegram user ID"),
      telegramUsername: z.string().optional().describe("Telegram username"),
      displayName: z.string().describe("Telegram display name"),
      telegramBio: z.string().optional().describe("Telegram profile description/bio"),
      companyHints: z.string().optional().describe("Comma-separated company hints from group context or Telegram bio"),
      phone: z.string().optional().describe("Phone number"),
      targetRecordId: z.string().default("").describe("Attio Person record ID"),
      targetName: z.string().optional().describe("Human-readable target name"),
      status: z.string().default("approved").describe("suggested, approved, ignored, or needs_review"),
      confidence: z.number().optional().describe("Confidence from 0 to 1"),
      reason: z.string().default("manual identity mapping").describe("Short mapping rationale"),
      dryRun: z.boolean().default(false).describe("Preview without writing to Attio"),
    }),
    run: (c) => runAttio(() => cmdIdentitiesUpsert(commandFlags({
      "identity-object": c.options.identityObject,
      "telegram-user-id": c.options.telegramUserId,
      "telegram-username": c.options.telegramUsername,
      "display-name": c.options.displayName,
      "telegram-bio": c.options.telegramBio,
      "company-hints": c.options.companyHints,
      phone: c.options.phone,
      "target-record-id": c.options.targetRecordId,
      "target-name": c.options.targetName,
      status: c.options.status,
      confidence: c.options.confidence,
      reason: c.options.reason,
      "dry-run": c.options.dryRun,
    }))),
  });

const syncAttioFolderOptions = z.object({
  folder: z.string().default("Attio").describe("Telegram folder to receive approved association chats"),
  object: z.string().default("telegram_associations").describe("Attio association object slug"),
  includePeople: z.boolean().default(true).describe("Include approved person/DM associations"),
  dryRun: z.boolean().default(false).describe("Preview without changing Telegram"),
});

export const syncAttioFolderCommand = {
  description: "Add approved Telegram Association chats to the Attio review folder",
  options: syncAttioFolderOptions,
  run: (c: { options: z.infer<typeof syncAttioFolderOptions> }) => runTelegramAndAttio(() => cmdFoldersSyncAttio(commandFlags({
    folder: c.options.folder,
    object: c.options.object,
    "include-people": c.options.includePeople,
    "dry-run": c.options.dryRun,
  }))),
};

const attioDoctorOptions = z.object({
  skipTelegram: z.boolean().default(false).describe("Skip Telegram session and folder checks"),
  skipAttio: z.boolean().default(false).describe("Skip Attio association and identity checks"),
  skipRailway: z.boolean().default(false).describe("Skip Railway service status checks"),
  limit: z.number().default(500).describe("Maximum Attio records to inspect for counts and dead-target checks"),
});

export const attioDoctorCommand = {
  description: "Check Telegram, Attio, Railway, and local sync state",
  options: attioDoctorOptions,
  run: (c: { options: z.infer<typeof attioDoctorOptions> }) => runLocal(() => cmdDoctor(commandFlags({
    "skip-telegram": c.options.skipTelegram,
    "skip-attio": c.options.skipAttio,
    "skip-railway": c.options.skipRailway,
    limit: c.options.limit,
  }))),
};
