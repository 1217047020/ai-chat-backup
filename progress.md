# Progress log

## 2026-07-16

- Read the planning-with-files instructions and restored the current workspace state.
- Confirmed TypeScript compilation and the existing eight unit tests pass.
- Found provider page bridge and collector entrypoints already implemented by the adapter work; runtime entrypoint is still a scaffold and needs integration.
- Integrated the background runtime, consent gate, per-provider scan watermarks, durable queue processing, Drive authorization, popup/options console, and current-page capture.
- Pinned the React WXT module to a Vite-compatible version; a final compile exposed an unsupported `options.openInTab` config field, which was removed before rerunning verification.
- Added IndexedDB integration tests for latest-job deduplication, 24-hour/two-pass missing detection, and checkpoint restoration; the suite now passes 15 tests in 5 files.
- Verified the generated Manifest V3 uses only `storage`, `identity`, `alarms`, exact ChatGPT/Claude hosts, and Drive API hosts. No OAuth client is embedded until the owner supplies `WXT_GOOGLE_CLIENT_ID`.
- Built `.output/chrome-mv3` and packaged `.output/ai-chat-backup-0.1.0-chrome.zip`, including the Claude Exporter MIT notice.
- Localized the popup and options UI to Simplified Chinese, including status labels, consent text, controls, timestamps, and known runtime errors.
- Added an optional `WXT_OUTPUT_DIR` build target and generated the unlocked Chinese build in `.output-cn/chrome-mv3` plus `.output-cn/ai-chat-backup-0.1.0-chrome.zip`.
- Verified the UTF-8 manifest, `drive.file` OAuth scope, packaged file list, TypeScript compilation, and all 15 tests after localization.
- Started stable extension identity setup for multi-computer developer-mode installation. The private key will remain local and ignored; only the public key will be embedded in the manifest.
- Generated and validated the stable identity `jppajeoobhcnolldlpdlmdnhennepeaa`; TypeScript and all 15 tests pass. The first stable-ID build succeeded, while the immediately chained ZIP command encountered a transient Windows `EBUSY` lock on the generated manifest.
- Embedded the public identity key through WXT, added a guarded `pnpm identity:generate` workflow, documented multi-computer installation and OAuth migration, and rebuilt both `.output` and `.output-cn` packages.
- Verified both manifests calculate to `jppajeoobhcnolldlpdlmdnhennepeaa`, retain only `storage`, `identity`, `alarms` plus `drive.file`, and both ZIP archives contain no `.pem`, `.keys`, or private-key entries.
