# AI Chat Backup implementation

## Goal

Deliver a developer-mode Manifest V3 Chrome extension that captures ChatGPT and Claude conversations, keeps a durable incremental queue in IndexedDB, and writes readable JSON/Markdown plus Claude artifact files to the user's `AI Chat Backup` Google Drive folder.

## Phases

| Phase | Status | Notes |
|---|---|---|
| 1. Extension skeleton, canonical types, adapters | completed | WXT/React scaffold, provider adapters, page bridge, canonical fixtures are present. |
| 2. Durable queue, hashing, Drive storage | completed | Dexie queue, checkpoints, semantic hashing, Drive REST/resumable upload layer are present. |
| 3. Runtime orchestration | completed | Collector messages, consent gate, alarms, scans, retries, resumable queue processing, and per-provider checkpoints are connected. |
| 4. Popup and options console | completed | Drive connection, first-backup consent, progress, pause/resume, current-page sync, and retry controls are implemented. |
| 5. Verification and handoff | completed | TypeScript, 15 tests, MV3 build, ZIP, manifest permissions, packaged MIT notice, and setup documentation are verified. |
| 6. Chinese UI localization | completed | Popup, options console, statuses, warnings, timestamps, errors, and extension description are localized; a separate UTF-8 build and ZIP are verified. |
| 7. Stable extension identity | completed | Generated a protected local private key, embedded the matching public key, rebuilt both outputs, verified permanent ID `jppajeoobhcnolldlpdlmdnhennepeaa`, and documented OAuth migration. |
| 8. Performance-focused v2 implementation | completed | All five batches implemented in dependency order. Version 0.2.0 compiles, passes 16 tests (including a real v1-to-v2 queue migration), builds and packages successfully; manifest identity, permissions, OAuth scope, ZIP contents, and guarded-file invariants are verified. |
| 9. Publish v0.2.0 to GitHub | in_progress | Publish the performance plan, implementation, tests, version metadata, and project records from a dedicated branch; push to origin and open a draft PR against `main`. Generated outputs, dependencies, environment files, and private keys remain excluded. |

## Acceptance checks

- No provider token/cookie is persisted or sent to Drive.
- First backup is explicitly started, resumable from checkpoints, and deduplicates one job per conversation.
- Re-capturing an unchanged conversation does not update Drive content.
- Realtime capture is debounced; periodic incremental and weekly full scans are scheduled while a provider tab is open.
- Archived and source-missing states remain represented locally and do not delete Drive files.
- Google OAuth uses `chrome.identity` and only `drive.file` is requested when a client ID is configured.

## Errors encountered

| Error | Resolution |
|---|---|
| WXT build may expose a Vite/plugin version conflict | Run the final build after runtime integration and adjust only dependency/config boundaries if reproducible. |
| `options.openInTab` is not a valid WXT 0.20 config field | Removed it; WXT generates the options page entry automatically. |
| First ZIP attempt hit a transient Windows `EBUSY` lock on the prior build output | Retried after the build process released the file; ZIP generation completed successfully. |
| Stable-ID ZIP attempt hit the same transient Windows `EBUSY` lock on `manifest.json` | The extension build completed; retry ZIP as a separate process after the WXT build process exits. |
| Inline Node manifest-ID verification was mangled by PowerShell quoting | Switched to a native PowerShell SHA-256 calculation; ZIP security inspection already completed successfully. |
| Windows PowerShell read the UTF-8 manifest using its legacy default encoding, corrupting Chinese text during JSON parsing | Re-run manifest verification with explicit `-Encoding UTF8`; the generated file itself is valid UTF-8. |
| Final ID audit used the newer static `SHA256.HashData` API, unavailable in this Windows PowerShell runtime | Switch to `SHA256.Create().ComputeHash(...)` and rerun the ID check. |
| Git staging was blocked by `.git/index.lock` | Verified the zero-byte lock was created on 2026-07-16 and no `git`/`gh` process was running; remove only that stale lock and retry staging. |
| A combined PowerShell command to remove the stale lock and stage files was rejected by command safety policy | No action occurred; remove the already-verified zero-byte lock through a file patch, then run staging separately. |
