# Security model

## Untrusted Telegram input

Messages, attachments, profiles, and chat titles are attacker-controlled data. Neither Unicode cleanup nor transcript escaping prevents semantic prompt injection. Do not execute commands, follow links, or grant permissions because a Telegram message asks you to.

The unattended worker copies selected text/metadata to SQLite and Attio. It does not execute message text, follow message URLs, download attachments, or expose an inbound application server. SQLite message inserts are parameterized. Protocol/runtime/dependency vulnerabilities remain possible; this is not a proof of absence of remote-code execution.

## Agent capabilities

- The full CLI denies guarded writes by default, including media and CRM mutation handlers. Explicit `warn`/`off` modes are unsafe compatibility settings. Environment-based approval is not a security boundary against a caller with a shell.
- The separate `tellatio-readonly` MCP server registers only `me`, `chats`, `info`, `read`, and `search`. No environment override can add a write tool to that registry.
- A strong host boundary requires running that server in an isolated container/account, with no home/repository/Docker-socket mounts and no host shell or credential-file access for the consuming agent. The repository does not automatically reconfigure existing agent integrations.
- Telegram session credentials themselves have account-write authority. A compromise of the credential-holding process can still affect the Telegram account. Revoke sessions after credential exposure.

## Files and deployment

Media transfer accepts only non-hidden basenames within `DATA_DIR/uploads` or `DATA_DIR/downloads`, capped at 25 MiB. Downloads use exclusive, no-follow creation and never overwrite. Uploads reject symlinks, hard links, directories, and nonregular files, and pass bounded buffers rather than reusable paths to GramJS. No downloaded file is automatically opened or executed.

New state and media files use owner-only permissions. Protect the entire parent directory; same-user filesystem races and a hostile OS administrator are outside this application's trust boundary. Keep `.env`, backups, state, and secret files out of source control and build contexts.

The Docker runtime drops root through its entrypoint, contains production dependencies only, and excludes the host home directory. Use a read-only root filesystem and drop capabilities where supported. `docker-compose.yml` and `iron.policy.yaml` are illustrative configurations, not verified network enforcement. An HTTP proxy alone does not restrict MTProto or prevent session abuse.

## Sync integrity

Remote-write failures must not advance chat cursors. Retries deduplicate local transcript entries; failed fetches and association-list API errors produce failed run state, not a clean-success claim. The worker syncs completed UTC days, not today's messages. An idle successful cycle proves polling, not a fresh Attio write. Old transcripts are not retroactively rerendered on deployment.

## Review and remaining limitations (October 20, 2026)

Regression coverage includes fail-closed guards, real media handlers with offline Telegram doubles, overwrite/traversal/symlink/hardlink rejection, bounded transfers, untrusted Markdown/HTML rendering, private state, remote-write retry/checkpoint behavior, and the actual MCP stdio tool list under write-enabling environment overrides. Docker builds run these checks before producing the runtime image. CI also audits dependencies.

The upstream `telegram` package is marked archived/deprecated in its registry metadata. Migration to a maintained implementation needs separate protocol/API compatibility testing; it is not silently substituted in this security patch. Registry audits do not cover all native SQLite, Node, Bun, OS, or unpublished vulnerabilities. This review is not host forensics, penetration testing of Telegram/Attio, or evidence that the machine is uncompromised.
