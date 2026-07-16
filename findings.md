# Findings

- The installed ChatGPT Degrade Checker exposes read-only conversation, project, workspace, archive, and message-tree endpoints. The new adapter isolates those calls and does not copy its UI or ZIP/export state.
- Claude Exporter v1.10.17 is MIT licensed. The new Claude adapter retains an attribution constant and a project notice; it normalizes message trees, thinking/tool blocks, artifacts, and attachment metadata.
- Page-world execution is required for provider cookies/session state. `page-bridge.content.ts` runs fixed, allow-listed operations in MAIN world; `collector.content.ts` receives only normalized snapshots through `window.postMessage` and forwards them to the worker.
- Drive uses `drive.file`, appProperties lookups, multipart uploads for small files, and resumable uploads for larger files. IndexedDB stores upload session state so a service-worker restart can resume.
- Upstream Claude Exporter `LICENSE.md` identifies the project as MIT licensed with `Copyright 2025 agoramachina`; the full notice is packaged in the extension. Source: https://github.com/agoramachina/claude-exporter/blob/main/LICENSE.md
- Chrome derives an extension ID from the manifest public `key`; keeping that value identical makes unpacked installs use the same ID across paths and computers. The existing OAuth client remains bound to the old ID, so a new Chrome Extension OAuth client must be created for the resulting fixed ID.
