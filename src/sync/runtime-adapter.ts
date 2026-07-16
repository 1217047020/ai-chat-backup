import type {
  CanonicalConversationV1,
  ConversationPage,
  NormalizeContext,
  ProviderAdapter,
  Scope,
} from '../shared/types';

type Provider = 'chatgpt' | 'claude';

interface BridgeMessage {
  type:
    | 'provider_detect_scopes'
    | 'provider_list_conversations'
    | 'provider_fetch_conversation'
    | 'provider_fetch_current';
  scope?: Scope;
  cursor?: string | null;
  sourceId?: string;
}

interface BridgeResponse {
  ok?: boolean;
  error?: string;
  status?: number;
  retryAfterMs?: number;
  scopes?: Scope[];
  page?: ConversationPage;
  conversation?: CanonicalConversationV1;
}

function providerPatterns(provider: Provider): string[] {
  return provider === 'claude'
    ? ['https://claude.ai/*']
    : ['https://chatgpt.com/*', 'https://chat.openai.com/*'];
}

function queryTabs(patterns: string[]): Promise<chrome.tabs.Tab[]> {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ url: patterns }, (tabs) => {
      const error = chrome.runtime.lastError?.message;
      if (error) reject(new Error(error));
      else resolve(tabs ?? []);
    });
  });
}

function providerError(response: BridgeResponse): Error {
  const error = new Error(response.error || 'Provider page request failed.') as Error & {
    status?: number;
    retryAfterMs?: number;
  };
  error.status = response.status;
  error.retryAfterMs = response.retryAfterMs;
  return error;
}

/** Routes fixed provider operations to a signed-in content page. */
export class RuntimeProviderAdapter implements ProviderAdapter {
  readonly adapterVersion = 'runtime-page-bridge-v1';

  constructor(readonly platform: Provider) {}

  async hasOpenTab(): Promise<boolean> {
    return (await queryTabs(providerPatterns(this.platform))).some((tab) => tab.id != null);
  }

  private async request(message: BridgeMessage): Promise<BridgeResponse> {
    const tabs = await queryTabs(providerPatterns(this.platform));
    const candidate = tabs.find((tab) => tab.active && tab.id != null) ?? tabs.find((tab) => tab.id != null);
    if (candidate?.id == null) throw new Error(`Open a ${this.platform === 'claude' ? 'Claude' : 'ChatGPT'} page before scanning.`);
    const response = await new Promise<BridgeResponse>((resolve, reject) => {
      chrome.tabs.sendMessage(candidate.id as number, message, (value) => {
        const error = chrome.runtime.lastError?.message;
        if (error) reject(new Error(error));
        else resolve((value ?? {}) as BridgeResponse);
      });
    });
    if (!response.ok) throw providerError(response);
    return response;
  }

  async detectScopes(): Promise<Scope[]> {
    return (await this.request({ type: 'provider_detect_scopes' })).scopes ?? [];
  }

  async listConversations(scope: Scope, cursor?: string | null): Promise<ConversationPage> {
    const response = await this.request({ type: 'provider_list_conversations', scope, cursor });
    if (!response.page) throw new Error('Provider returned no conversation page.');
    return response.page;
  }

  async fetchConversation(scope: Scope, sourceId: string): Promise<CanonicalConversationV1> {
    const response = await this.request({ type: 'provider_fetch_conversation', scope, sourceId });
    if (!response.conversation) throw new Error('Provider returned no conversation.');
    return response.conversation;
  }

  async fetchCurrentConversation(): Promise<CanonicalConversationV1 | undefined> {
    return (await this.request({ type: 'provider_fetch_current' })).conversation;
  }

  normalize(raw: any, _context: NormalizeContext): CanonicalConversationV1 {
    if (raw && raw.schemaVersion === 1 && (raw.provider === 'chatgpt' || raw.provider === 'claude')) return raw as CanonicalConversationV1;
    throw new Error('Runtime provider adapter receives normalized snapshots only.');
  }

  observeCurrentConversation(_callback: (conversation: CanonicalConversationV1) => void): () => void {
    return () => undefined;
  }
}

