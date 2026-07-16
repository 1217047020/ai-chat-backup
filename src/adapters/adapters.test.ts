import { describe, expect, it } from "vitest";
import type { JsonValue, NormalizeContext, Scope } from "../shared/types";
import { ChatGPTAdapter } from "./chatgpt";
import { ClaudeAdapter } from "./claude";
import { artifactFiles, conversationToMarkdown } from "./markdown";
import { sanitizeProviderValue } from "./utils";
import chatgptFixture from "./fixtures/chatgpt-mapping.json";
import claudeFixture from "./fixtures/claude-artifact.json";

const chatScope: Scope = {
  scopeKey: "personal",
  platform: "chatgpt",
  accountIdHash: "account",
  displayName: "Personal",
  kind: "personal",
};
const claudeScope: Scope = {
  scopeKey: "org-1",
  platform: "claude",
  accountIdHash: "account",
  organizationId: "org-1",
  displayName: "Org",
  kind: "organization",
};

const context = (scope: Scope, sourceId: string): NormalizeContext => ({
  provider: scope.platform,
  scope,
  sourceId,
  adapterVersion: "test",
});

describe("provider normalization", () => {
  it("keeps ChatGPT alternate mapping branches and current branch", () => {
    const adapter = new ChatGPTAdapter({ fetch: (() => Promise.reject(new Error("not used"))) as typeof fetch });
    const conversation = adapter.normalize(chatgptFixture as unknown as JsonValue, context(chatScope, "chat-1"));
    expect(conversation.branches).toHaveLength(2);
    expect(conversation.currentBranchId).toBe("branch:assistant-current");
    expect(conversation.messages.find((message) => message.id === "assistant-current")?.content[0]).toMatchObject({ type: "text", text: "Current answer" });
  });

  it("parses Claude artifacts, thinking, and attachment metadata", () => {
    const adapter = new ClaudeAdapter({ fetch: (() => Promise.reject(new Error("not used"))) as typeof fetch });
    const conversation = adapter.normalize(claudeFixture as unknown as JsonValue, context(claudeScope, "conv-1"));
    expect(conversation.visibleThoughts[0].text).toBe("Plan");
    expect(conversation.artifacts[0]).toMatchObject({ name: "hello.js", hasBody: true });
    expect(conversation.attachments[0]).toMatchObject({ name: "input.txt", sizeBytes: 12 });
    expect(JSON.stringify(conversation.raw)).not.toContain("secret body");
    expect(conversation.currentBranchId).toBe("branch:assistant");
  });
});

describe("adapter output helpers", () => {
  it("renders active branch and emits deterministic artifact files", () => {
    const adapter = new ClaudeAdapter({ fetch: (() => Promise.reject(new Error("not used"))) as typeof fetch });
    const conversation = adapter.normalize({ uuid: "conv-2", name: "Markdown", chat_messages: [{ uuid: "m", sender: "assistant", content: [{ type: "text", text: "Hello" }] }] }, context(claudeScope, "conv-2"));
    expect(conversationToMarkdown(conversation)).toContain("Hello");
    conversation.artifacts.push({ artifactId: "a", name: "script", language: "javascript", text: "alert(1)", hasBody: true });
    expect(artifactFiles(conversation)[0].filename).toBe("script.js");
  });

  it("redacts credentials and signed URLs in raw provider values", () => {
    const sanitized = sanitizeProviderValue({ Authorization: "Bearer secret", url: "https://x.test/a?X-Amz-Signature=secret", nested: { cookie: "abc" }, attachments: [{ file_name: "a.txt", content: "attachment body" }] });
    expect(JSON.stringify(sanitized)).not.toContain("secret");
    expect(sanitized).toMatchObject({ Authorization: "<redacted>", url: "https://x.test/a", nested: { cookie: "<redacted>" }, attachments: [{ content: "<omitted-attachment-content>" }] });
  });
});

describe("provider request compatibility", () => {
  it("uses the ChatGPT session token and compatible list endpoint", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/api/auth/session")) return new Response(JSON.stringify({ accessToken: "token-1", user: { id: "user-1" } }), { status: 200, headers: { "content-type": "application/json" } });
      if (url.includes("/backend-api/conversations")) return new Response(JSON.stringify({ items: [], total: 0 }), { status: 200, headers: { "content-type": "application/json" } });
      if (url.includes("/backend-api/gizmos/snorlax/sidebar")) return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "content-type": "application/json" } });
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;
    const adapter = new ChatGPTAdapter({ fetch: fakeFetch, throttleMs: 0 });
    const scopes = await adapter.detectScopes();
    expect(scopes[0].scopeKey).toBe("personal");
    await adapter.listConversations(scopes[0]);
    const listCall = calls.find((call) => call.url.includes("/backend-api/conversations"));
    expect(listCall?.url).toContain("offset=0");
    expect(listCall?.url).toContain("limit=100");
    expect((listCall?.init?.headers as Record<string, string>).Authorization).toBe("Bearer token-1");
  });

  it("uses Claude organization/list/detail endpoints and preserves chat capability filtering", async () => {
    const calls: string[] = [];
    const fakeFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/api/organizations")) return new Response(JSON.stringify([{ uuid: "org-1", name: "Org", capabilities: ["chat"] }]), { status: 200 });
      if (url.endsWith("/api/organizations/org-1/projects")) return new Response(JSON.stringify([{ uuid: "project-1", name: "Project" }]), { status: 200 });
      if (url.endsWith("/api/organizations/org-1/chat_conversations")) return new Response(JSON.stringify([{ uuid: "conv-1", name: "Conversation" }]), { status: 200 });
      if (url.includes("/chat_conversations/conv-1?")) return new Response(JSON.stringify({ uuid: "conv-1", name: "Conversation", chat_messages: [] }), { status: 200 });
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;
    const adapter = new ClaudeAdapter({ fetch: fakeFetch, throttleMs: 0 });
    const scopes = await adapter.detectScopes();
    expect(scopes).toHaveLength(1);
    const page = await adapter.listConversations(scopes[0]);
    expect(page.items[0].sourceId).toBe("conv-1");
    await adapter.fetchConversation(scopes[0], "conv-1");
    expect(calls.some((url) => url.includes("tree=True&rendering_mode=messages&render_all_tools=true"))).toBe(true);
  });
});
