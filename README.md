# AI Chat Backup

Personal-use Chrome Manifest V3 extension for backing up ChatGPT and Claude conversations to a visible Google Drive folder.

## Current status

This repository is intentionally designed as a personal developer-mode build. It does not publish or send chat data to a service operated by the author. Chat content is uploaded only to the Google Drive account explicitly connected by the user.

## Development

The extension has a stable manifest identity. Its permanent extension ID is:

```text
jppajeoobhcnolldlpdlmdnhennepeaa
```

1. Install a current Node.js LTS and pnpm, then run `pnpm install` and `pnpm build`.
2. Open `chrome://extensions`, enable Developer mode, and load `.output/chrome-mv3`. Confirm that Chrome shows the permanent ID above.
3. In Google Cloud, enable the Google Drive API and create a **Chrome Extension** OAuth client bound to that permanent ID.
4. Copy `.env.example` to `.env`, set `WXT_GOOGLE_CLIENT_ID` to that client's ID, run `pnpm build` again, and reload the unpacked extension.
5. Copy the same built extension directory to other computers. The embedded public key keeps the extension ID identical on every computer.
6. Keep at least one signed-in ChatGPT or Claude tab open, connect Drive from the popup, and explicitly confirm **Start first backup**.

`config/extension-public-key.txt` is intentionally part of the project and is safe to distribute. The corresponding private key is stored only in `.keys/ai-chat-backup-private.pem`, which is ignored by Git. Back up that private key securely and never share it. Running `pnpm identity:generate` again validates the existing key pair instead of replacing it.

Changing from a path-derived unpacked ID to this stable ID requires a new Chrome Extension OAuth client. An OAuth client that was created for the previous ID cannot authenticate the new fixed-ID build.

The extension requires the Google Drive API and the non-sensitive `drive.file` scope. The OAuth client must be bound to the installed extension ID. No ChatGPT or Claude credentials are requested by this project; the collectors use the existing signed-in web sessions while the matching site tabs are open.

## Backup behavior

- The first backup is explicitly started from the dashboard and can be resumed after a restart.
- Later updates are conversation-level incremental updates based on a stable semantic hash.
- JSON is the canonical archive; Markdown is a readable mirror of the current branch.
- Claude artifacts are stored as separate files; ordinary attachments are represented by metadata only.
- Source conversations are never deleted from Drive when they disappear from the provider.

## Privacy and safety

The extension does not request cookies, `<all_urls>`, `webRequest`, or full Drive access. Provider access tokens remain in the page/session context and are never written to IndexedDB or logs. Drive files are intentionally readable plaintext because this personal build prioritizes inspection and portability.

## Third-party notices

The Claude parsing/formatting compatibility layer is derived from the MIT-licensed Claude Exporter project. See `THIRD_PARTY_NOTICES.md` for attribution. The ChatGPT compatibility layer is for this personal build only and is kept behind an adapter boundary so it can be replaced with an authorized implementation if the project is ever shared.
