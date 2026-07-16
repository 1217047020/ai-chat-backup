import { defineContentScript } from "wxt/utils/define-content-script";
import type { CanonicalConversationV1, Scope } from "../src/shared/types";
import { PageBridgeClient } from "../src/content/bridgeClient";

type Provider = "chatgpt" | "claude";

function providerForPage(): Provider {
  return /(^|\.)claude\.ai$/i.test(location.hostname) ? "claude" : "chatgpt";
}

function sendCapture(
  conversation: CanonicalConversationV1,
  trigger: "observer" | "manual" = "observer",
): void {
  try {
    void chrome.runtime.sendMessage({
      type: "conversation_captured",
      platform: providerForPage(),
      conversation,
      trigger,
    });
  } catch {
    // The page can close while a capture is being delivered.
  }
}

export default defineContentScript({
  matches: ["*://chatgpt.com/*", "*://chat.openai.com/*", "https://claude.ai/*"],
  runAt: "document_idle",
  main() {
    const provider = providerForPage();
    const bridge = new PageBridgeClient(provider);
    bridge.start();
    const unsubscribe = bridge.onConversation((conversation) =>
      sendCapture(conversation, "observer"),
    );
    try {
      void chrome.runtime.sendMessage({ type: "content_ready", platform: provider, url: location.href });
    } catch {
      // Runtime can be unavailable during extension reload.
    }

    const requestCurrent = () => {
      void bridge.fetchCurrentConversation().then((conversation) => {
        if (conversation) sendCapture(conversation, "manual");
      }).catch(() => undefined);
    };
    // Capture an already-open conversation after the page has settled.
    window.setTimeout(requestCurrent, 750);
    const onVisibility = () => { if (document.visibilityState === "hidden") requestCurrent(); };
    document.addEventListener("visibilitychange", onVisibility);

    const onRuntimeMessage = (message: any, _sender: chrome.runtime.MessageSender, sendResponse: (response?: any) => void) => {
      if (!message || typeof message.type !== "string") return false;
      if (message.type === "provider_detect_scopes") {
        void bridge.detectScopes().then((scopes) => sendResponse({ ok: true, scopes })).catch((error) => sendResponse({ ok: false, error: error?.message || "Unable to detect scopes" }));
        return true;
      }
      if (message.type === "provider_list_conversations") {
        const scope = message.scope as Scope;
        void bridge.listConversations(scope, message.cursor).then((page) => sendResponse({ ok: true, page })).catch((error) => sendResponse({ ok: false, error: error?.message || "Unable to list conversations", status: error?.status }));
        return true;
      }
      if (message.type === "provider_fetch_conversation") {
        const scope = message.scope as Scope;
        void bridge.fetchConversation(scope, String(message.sourceId || "")).then((conversation) => sendResponse({ ok: true, conversation })).catch((error) => sendResponse({ ok: false, error: error?.message || "Unable to fetch conversation", status: error?.status }));
        return true;
      }
      if (message.type === "provider_fetch_current") {
        void bridge.fetchCurrentConversation().then((conversation) => sendResponse({ ok: true, conversation })).catch((error) => sendResponse({ ok: false, error: error?.message || "Unable to fetch current conversation" }));
        return true;
      }
      return false;
    };
    chrome.runtime.onMessage.addListener(onRuntimeMessage);

    window.addEventListener("pagehide", () => {
      unsubscribe();
      bridge.stop();
      document.removeEventListener("visibilitychange", onVisibility);
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    }, { once: true });
  },
});
