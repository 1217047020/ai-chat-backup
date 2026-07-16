export * from "./utils";
export * from "./markdown";
export * from "./chatgpt";
export * from "./claude";

import type { Platform, ProviderAdapter } from "../shared/types";
import { ChatGPTAdapter } from "./chatgpt";
import { ClaudeAdapter } from "./claude";

export function createProviderAdapter(platform: Platform): ProviderAdapter {
  return platform === "claude" ? new ClaudeAdapter() : new ChatGPTAdapter();
}
