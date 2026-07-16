import type { RuntimeMessage, RuntimeResponse, SyncStatusSnapshot } from '../shared/types';

export function sendRuntime(message: RuntimeMessage): Promise<RuntimeResponse> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: RuntimeResponse | undefined) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message || '\u6269\u5c55\u540e\u53f0\u6682\u65f6\u4e0d\u53ef\u7528\u3002'));
      else resolve(response ?? { ok: true });
    });
  });
}
export function isStatusResponse(response: RuntimeResponse): response is { ok: true; status: SyncStatusSnapshot } { return response.ok === true && Boolean(response.status); }
export function formatTime(timestamp?: number): string { return timestamp ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(timestamp)) : '\u5c1a\u672a\u540c\u6b65'; }
