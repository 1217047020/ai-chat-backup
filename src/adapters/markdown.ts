import type { CanonicalConversationV1, ContentBlock, ConversationMessage } from '../shared/types';
import { getBranchMessages, safeFilename } from './utils';

function fenceFor(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) || []).map((run) => run.length));
  return '`'.repeat(Math.max(4, longest + 1));
}
function json(value: unknown): string {
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}
function renderBlock(block: ContentBlock): string {
  switch (block.type) {
    case 'text': return block.text ? `${block.text}\n\n` : '';
    case 'thinking': return block.text ? `### Thinking\n${fenceFor(block.text)}text\n${block.text}\n${fenceFor(block.text)}\n\n` : '';
    case 'tool_call': {
      let output = `### Tool: ${block.name || 'unknown'}\n`;
      if (block.arguments !== undefined) output += `${fenceFor(json(block.arguments))}json\n${json(block.arguments)}\n${fenceFor(json(block.arguments))}\n\n`;
      if (block.result !== undefined) output += `**Result**\n${fenceFor(json(block.result))}json\n${json(block.result)}\n${fenceFor(json(block.result))}\n\n`;
      return output;
    }
    case 'artifact': return `### Artifact: ${block.name || block.artifactId}\n\n`;
    case 'image':
    case 'file': {
      const parts = [block.name || block.sourceId || 'attachment'];
      if (block.mimeType) parts.push(block.mimeType);
      if (block.sizeBytes != null) parts.push(`${block.sizeBytes} bytes`);
      return `### Attachment: ${parts.join(' | ')}\n\n`;
    }
    case 'unknown': return block.data === undefined ? '' : `### Provider block (${block.sourceType || 'unknown'})\n${fenceFor(json(block.data))}json\n${json(block.data)}\n${fenceFor(json(block.data))}\n\n`;
  }
}
function renderMessage(message: ConversationMessage): string {
  const role = message.role === 'user' ? 'User' : message.role === 'assistant' ? 'Assistant' : message.role[0]?.toUpperCase() + message.role.slice(1);
  let output = `## ${role}\n\n`;
  if (message.createdAt) output += `_${message.createdAt}_\n\n`;
  for (const block of message.content || []) output += renderBlock(block);
  return output || '\n';
}
export function conversationToMarkdown(conversation: CanonicalConversationV1): string {
  let markdown = `# ${conversation.title || 'Untitled Conversation'}\n\n`;
  if (conversation.createdAt) markdown += `**Created:** ${conversation.createdAt}\n`;
  if (conversation.updatedAt) markdown += `**Updated:** ${conversation.updatedAt}\n`;
  if (conversation.model) markdown += `**Model:** ${conversation.model}\n`;
  markdown += `**Provider:** ${conversation.provider}\n**Source ID:** ${conversation.sourceId}\n\n---\n\n`;
  for (const message of getBranchMessages(conversation.messages, conversation.branches, conversation.currentBranchId)) markdown += renderMessage(message);
  if (conversation.artifacts.length) {
    markdown += '## Artifacts\n\n';
    for (const artifact of conversation.artifacts) {
      const label = safeFilename(artifact.name || artifact.artifactId);
      markdown += `- \`${label}\`${artifact.hasBody ? '' : ' (metadata only)'}\n`;
    }
    markdown += '\n';
  }
  if (conversation.attachments.length) {
    markdown += '## Attachments\n\n';
    for (const attachment of conversation.attachments) {
      const label = attachment.name || attachment.sourceId || attachment.attachmentId || 'attachment';
      const meta = [attachment.mimeType, attachment.sizeBytes != null ? `${attachment.sizeBytes} bytes` : undefined].filter(Boolean).join(', ');
      markdown += `- ${label}${meta ? ` (${meta})` : ''}\n`;
    }
    markdown += '\n';
  }
  return markdown.trimEnd() + '\n';
}

export interface ArtifactFile { filename: string; content: string; mimeType?: string; artifactId: string; }
const extensionByLanguage: Record<string, string> = {
  javascript: '.js', js: '.js', typescript: '.ts', ts: '.ts', python: '.py', py: '.py', html: '.html', css: '.css', scss: '.scss', markdown: '.md', md: '.md', json: '.json', yaml: '.yaml', yml: '.yml', sql: '.sql', bash: '.sh', shell: '.sh', sh: '.sh', jsx: '.jsx', tsx: '.tsx', java: '.java', rust: '.rs', go: '.go', svg: '.svg',
};
const mimeByExtension: Record<string, string> = { '.js': 'text/javascript', '.ts': 'text/typescript', '.py': 'text/x-python', '.html': 'text/html', '.css': 'text/css', '.md': 'text/markdown', '.json': 'application/json', '.svg': 'image/svg+xml', '.sh': 'text/x-shellscript', '.sql': 'application/sql' };
export function artifactFiles(conversation: CanonicalConversationV1): ArtifactFile[] {
  const used = new Set<string>();
  const files: ArtifactFile[] = [];
  for (const artifact of conversation.artifacts) {
    if (!artifact.hasBody || artifact.text == null) continue;
    const rawName = safeFilename(artifact.name || artifact.artifactId, 'artifact');
    const ext = extensionByLanguage[(artifact.language || '').toLowerCase()] || (artifact.mimeType === 'text/markdown' ? '.md' : '.txt');
    let filename = rawName.includes('.') ? rawName : `${rawName}${ext}`;
    let index = 1;
    while (used.has(filename)) {
      const dot = filename.lastIndexOf('.');
      filename = `${filename.slice(0, dot >= 0 ? dot : filename.length)}_${index++}${dot >= 0 ? filename.slice(dot) : ''}`;
    }
    used.add(filename);
    files.push({ filename, content: artifact.text, mimeType: artifact.mimeType || mimeByExtension[filename.slice(filename.lastIndexOf('.'))], artifactId: artifact.artifactId });
  }
  return files;
}

