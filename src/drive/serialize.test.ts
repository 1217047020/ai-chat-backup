import { describe, expect, it } from 'vitest';

import type { CanonicalConversationV1 } from '../shared/types';
import {
  attachmentsJson,
  conversationJson,
  conversationMarkdown,
} from './serialize';

const fixture: CanonicalConversationV1 = {
  schemaVersion: 1,
  conversationKey: 'chatgpt:personal:abc',
  provider: 'chatgpt',
  scope: {
    scopeKey: 'personal',
    accountIdHash: 'account',
    displayName: 'Personal',
    kind: 'personal',
    platform: 'chatgpt',
  },
  sourceId: 'abc',
  title: 'A conversation',
  messages: [
    {
      id: 'u',
      role: 'user',
      content: [{ type: 'text', text: 'Hello' }],
    },
    {
      id: 'a',
      role: 'assistant',
      content: [{ type: 'text', text: 'World' }],
    },
  ],
  branches: [{ id: 'main', messageIds: ['u', 'a'], isActive: true }],
  currentBranchId: 'main',
  tools: [],
  visibleThoughts: [],
  artifacts: [],
  attachments: [],
  sourceStatus: 'active',
  adapterVersion: 'test',
  capturedAt: '2025-01-01T00:00:00.000Z',
};

describe('Drive serializers', () => {
  it('renders the active branch as readable markdown', () => {
    const markdown = conversationMarkdown(fixture);
    expect(markdown).toContain('# A conversation');
    expect(markdown).toContain('## User');
    expect(markdown).toContain('Hello');
    expect(markdown).toContain('World');
  });

  it('writes canonical JSON and attachment metadata', () => {
    expect(JSON.parse(conversationJson(fixture, 'hash')).semanticHash).toBe('hash');
    expect(JSON.parse(attachmentsJson(fixture)).attachments).toEqual([]);
  });
});
