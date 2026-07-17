import { defineConfig } from "wxt";
import { loadEnv } from "vite";
import { readFileSync } from "node:fs";

const buildEnv = loadEnv(process.env.NODE_ENV ?? "production", process.cwd(), "");
const googleClientId = buildEnv.WXT_GOOGLE_CLIENT_ID?.trim();
const outputDirectory = process.env.WXT_OUTPUT_DIR?.trim() || ".output";
const extensionPublicKey = readFileSync(
  new URL("./config/extension-public-key.txt", import.meta.url),
  "utf8"
).trim();

if (!extensionPublicKey) {
  throw new Error("config/extension-public-key.txt must contain the stable manifest public key.");
}

export default defineConfig({
  outDir: outputDirectory,
  manifestVersion: 3,
  modules: ["@wxt-dev/module-react"],
  manifest: {
    key: extensionPublicKey,
    name: "AI Chat Backup",
    short_name: "AI Chat Backup",
    description:
      "\u5c06 ChatGPT \u548c Claude \u4f1a\u8bdd\u81ea\u52a8\u589e\u91cf\u5907\u4efd\u5230 Google Drive\u3002",
    version: "0.2.0",
    permissions: ["storage", "identity", "alarms"],
    host_permissions: [
      "https://chatgpt.com/*",
      "https://chat.openai.com/*",
      "https://claude.ai/*",
      "https://www.googleapis.com/drive/v3/*",
      "https://www.googleapis.com/upload/drive/v3/*"
    ],
    action: {
      default_title: "AI Chat Backup",
      default_popup: "popup.html"
    },
    ...(googleClientId
      ? {
          oauth2: {
            client_id: googleClientId,
            scopes: ["https://www.googleapis.com/auth/drive.file"]
          }
        }
      : {})
  }
});
