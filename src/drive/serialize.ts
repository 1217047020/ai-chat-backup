import type {
  CanonicalConversationV1,
  ContentBlock,
  ConversationMessage,
  MessageRole,
} from '../shared/types';

function roleLabel(role: MessageRole): string {
  const labels: Record<MessageRole, string> = {
    system: 'System',
    user: 'User',
    assistant: 'Assistant',
    tool: 'Tool',
    developer: 'Developer',
    unknown: 'Unknown',
  };
  return labels[role];
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function renderBlock(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return block.markdown ?? block.text;
    case 'thinking':
      return block.visible ? `> Thinking\n> ${block.text.replace(/\n/g, '\n> ')}` : '';
    case 'tool_call': {
      const details = {
        id: block.id,
        name: block.name,
        arguments: block.arguments,
        result: block.result,
      };
      return `**Tool call: ${block.name}**\n\n\`\`\`json\n${json(details)}\n\`\`\``;
    }
    case 'artifact':
      return `**Artifact:** ${block.name ?? block.artifactId}`;
    case 'image':
    case 'file':
      return `**${block.type === 'image' ? 'Image' : 'File'}:** ${block.name ?? block.sourceId ?? 'unnamed'}${block.mimeType ? ` (${block.mimeType})` : ''}`;
    case 'unknown':
      return `\`\`\`json\n${json(block.data)}\n\`\`\``;
  }
}

function activeMessages(conversation: CanonicalConversationV1): ConversationMessage[] {
  const branch =
    conversation.branches.find((item) => item.id === conversation.currentBranchId) ??
    conversation.branches.find((item) => item.isActive);
  if (!branch) return conversation.messages;
  const byId = new Map(conversation.messages.map((message) => [message.id, message]));
  return branch.messageIds
    .map((id) => byId.get(id))
    .filter((message): message is ConversationMessage => Boolean(message));
}

export function conversationJson(
  conversation: CanonicalConversationV1,
  contentHash: string,
): string {
  return JSON.stringify({ ...conversation, semanticHash: contentHash }, null, 2);
}

export function conversationMarkdown(
  conversation: CanonicalConversationV1,
): string {
  const frontMatter = [
    '---',
    `title: ${JSON.stringify(conversation.title)}`,
    `provider: ${conversation.provider}`,
    `scope: ${JSON.stringify(conversation.scope.displayName)}`,
    `source_id: ${JSON.stringify(conversation.sourceId)}`,
    `source_status: ${conversation.sourceStatus}`,
    conversation.createdAt ? `created_at: ${conversation.createdAt}` : undefined,
    conversation.updatedAt ? `updated_at: ${conversation.updatedAt}` : undefined,
    '---',
    '',
  ].filter((line): line is string => Boolean(line));

  const messages = activeMessages(conversation).flatMap((message) => {
    const blocks = message.content.map(renderBlock).filter(Boolean);
    if (blocks.length === 0) return [];
    return [
      `## ${roleLabel(message.role)}`,
      '',
      ...(message.createdAt ? [`_${message.createdAt}_`, ''] : []),
      blocks.join('\n\n'),
      '',
    ];
  });
  return [...frontMatter, `# ${conversation.title}`, '', ...messages].join('\n');
}

export function attachmentsJson(conversation: CanonicalConversationV1): string {
  return JSON.stringify(
    {
      schemaVersion: 1,
      provider: conversation.provider,
      conversationKey: conversation.conversationKey,
      attachments: conversation.attachments,
    },
    null,
    2,
  );
}

export function extensionForArtifact(mimeType?: string, language?: string): string {
  const byMime: Record<string, string> = {
    'text/html': 'html',
    'text/markdown': 'md',
    'text/plain': 'txt',
    'text/css': 'css',
    'application/json': 'json',
    'application/javascript': 'js',
    'text/javascript': 'js',
    'image/svg+xml': 'svg',
  };
  if (mimeType && byMime[mimeType.toLowerCase()]) return byMime[mimeType.toLowerCase()];
  const normalized = language?.toLowerCase();
  const byLanguage: Record<string, string> = {
    javascript: 'js',
    typescript: 'ts',
    python: 'py',
    html: 'html',
    css: 'css',
    json: 'json',
    markdown: 'md',
    sql: 'sql',
    svg: 'svg',
  };
  return (normalized && byLanguage[normalized]) || 'txt';
}
