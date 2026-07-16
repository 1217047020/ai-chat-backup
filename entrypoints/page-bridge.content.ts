import { defineContentScript } from "wxt/utils/define-content-script";
import { installPageCollectionBridge } from "../src/content/pageBridge";

/** MAIN-world bridge: provider cookies/session state remain in the page. */
export default defineContentScript({
  matches: ["*://chatgpt.com/*", "*://chat.openai.com/*", "https://claude.ai/*"],
  runAt: "document_start",
  world: "MAIN",
  main() {
    installPageCollectionBridge();
  },
});

