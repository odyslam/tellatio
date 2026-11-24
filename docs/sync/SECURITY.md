# Attio and worker security

See [CLI security](../../SECURITY.md) for agent access and secrets. The worker copies text/metadata to SQLite and Attio; it does not execute messages, follow message links, or download attachments.

## Approval and identity

- Automatic person linking requires a unique stable Telegram ID or an approved identity mapping. Names, usernames, phone numbers, and company hints are review candidates only.
- Duplicate/malformed mappings, ignored identities, and missing approved targets fail closed. Auto-creation is opt-in and requires a stable ID with no candidate match.
- Reconciliation never approves new company destinations. Existing approvals are preserved, not re-audited; review older heuristic approvals separately.
- The worker rejects unknown/mismatched peer types and visible namespace collisions before fetching. Legacy SQLite keys remain bare chat IDs, so collisions with undiscovered historical peers are not covered.

## Transport and sync integrity

- Attio credentials go only to `https://api.attio.com/v2`; alternate origins and redirects are rejected. Requests have 30-second deadlines and 8 MiB request/response limits; response bodies are excluded from error logs.
- Only reads retry automatically at the HTTP layer. Later cycles may retry failed writes: delivery is not exactly once. Note replacement remains non-atomic (delete, then create); oversized replacements fail before deletion.
- Failed remote writes must not advance cursors. Failed fetches, unresolved folder identities, and association-list errors must not report success. Retries deduplicate local transcript entries.
- Only completed UTC days sync. Idle success does not prove a new Attio write; old transcripts are not automatically rerendered.

## Deployment limits

Use a read-only root filesystem with private writable state. The optional HTTP proxy does not constrain MTProto; enforce Telegram egress at the network layer. The worker still requires an Attio credential, and a compromised process can use its loaded Telegram session. Revoke exposed credentials. Reference Compose/policy files are not verified isolation guarantees.
