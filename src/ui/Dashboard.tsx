import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SyncStatusSnapshot } from '../shared/types';
import { formatTime, isStatusResponse, sendRuntime } from './runtime';

interface DashboardProps { compact?: boolean; }

const t = {
  queued: '\u5f85\u4e0a\u4f20',
  uploading: '\u4e0a\u4f20\u4e2d',
  failed: '\u5931\u8d25',
  discovered: '\u5df2\u53d1\u73b0\u7684\u804a\u5929',
  conversations: '\u4e2a\u4f1a\u8bdd',
  spaces: '\u4e2a\u7a7a\u95f4',
  subtitle: 'ChatGPT + Claude \u2192 Google Drive\uff08\u5355\u5411\u589e\u91cf\u5907\u4efd\uff09',
  devMode: '\u5f00\u53d1\u8005\u6a21\u5f0f\u6269\u5c55',
  connected: '\u5df2\u8fde\u63a5',
  disconnected: '\u5c1a\u672a\u8fde\u63a5',
  connecting: '\u8fde\u63a5\u4e2d...',
  reconnect: '\u91cd\u65b0\u6388\u6743',
  connect: '\u8fde\u63a5 Drive',
  consent: '\u5f00\u59cb\u9996\u6b21\u5907\u4efd\u524d\uff0c\u8bf7\u5148\u786e\u8ba4\u4e0a\u4f20\u63d0\u793a\u3002\u672a\u786e\u8ba4\u524d\u4e0d\u4f1a\u5c06\u4f1a\u8bdd\u52a0\u5165\u4e91\u7aef\u4e0a\u4f20\u961f\u5217\u3002',
  paused: '\u5df2\u6682\u505c',
  starting: '\u6b63\u5728\u5f00\u59cb\u626b\u63cf...',
  start: '\u5f00\u59cb\u9996\u6b21\u5907\u4efd',
  capturing: '\u6b63\u5728\u91c7\u96c6...',
  syncCurrent: '\u540c\u6b65\u5f53\u524d\u9875\u9762',
  working: '\u5904\u7406\u4e2d...',
  resume: '\u7ee7\u7eed\u540c\u6b65',
  pause: '\u6682\u505c\u540c\u6b65',
  retrying: '\u6b63\u5728\u91cd\u8bd5...',
  retry: '\u91cd\u8bd5\u5931\u8d25\u9879',
  console: '\u6253\u5f00\u63a7\u5236\u53f0',
  lastSync: '\u6700\u8fd1\u6210\u529f\u540c\u6b65',
  privacy: '\u6269\u5c55\u53ea\u8bfb\u53d6\u5f53\u524d\u6253\u5f00\u7684 ChatGPT/Claude \u9875\u9762\uff1b\u51ed\u8bc1\u548c Cookie \u4e0d\u4f1a\u5199\u5165 IndexedDB \u6216 Drive\u3002Drive \u6587\u4ef6\u662f\u53ef\u76f4\u63a5\u9605\u8bfb\u7684 JSON\u3001Markdown \u548c Artifact \u6587\u672c\u3002',
  confirm: '\u9996\u6b21\u5907\u4efd\u4f1a\u628a\u5f53\u524d\u6253\u5f00\u5e73\u53f0\u4e2d\u53ef\u8bbf\u95ee\u7684\u4e2a\u4eba\u3001\u56e2\u961f\u548c\u7ec4\u7ec7\u804a\u5929\u4e0a\u4f20\u5230 Google Drive\u3002\u662f\u5426\u7ee7\u7eed\uff1f',
  connectFirst: '\u8bf7\u5148\u8fde\u63a5 Google Drive\u3002',
  openProvider: '\u8bf7\u5148\u6253\u5f00 ChatGPT \u6216 Claude \u6807\u7b7e\u9875\u3002',
  consentRequired: '\u8bf7\u5148\u786e\u8ba4\u5e76\u5f00\u59cb\u9996\u6b21\u5907\u4efd\u3002',
  invalidConversation: '\u6536\u5230\u4e86\u6765\u81ea\u975e\u652f\u6301\u9875\u9762\u7684\u65e0\u6548\u4f1a\u8bdd\u3002',
  userPaused: '\u7528\u6237\u5df2\u6682\u505c\u540c\u6b65\u3002',
  driveDenied: 'Google Drive \u62d2\u7edd\u4e86\u6269\u5c55\u6743\u9650\uff0c\u8bf7\u91cd\u65b0\u6388\u6743\u3002',
  oauthMissing: '\u672a\u914d\u7f6e Google OAuth Client ID\u3002\u8bf7\u8bbe\u7f6e WXT_GOOGLE_CLIENT_ID \u540e\u91cd\u65b0\u6784\u5efa\u6269\u5c55\u3002',
} as const;

function localizeMessage(value?: string): string | undefined {
  if (!value) return value;
  const known: Record<string, string> = {
    'Connect Google Drive first.': t.connectFirst,
    'Open a ChatGPT or Claude tab before starting the first backup.': t.openProvider,
    'Confirm and start the first backup before uploading.': t.consentRequired,
    'Invalid conversation from an unsupported page.': t.invalidConversation,
    'Sync paused by the user.': t.userPaused,
    'Google Drive denied access. Please authorize again.': t.driveDenied,
  };
  if (known[value]) return known[value];
  if (value.includes('WXT_GOOGLE_CLIENT_ID') || value.includes('Google OAuth returned no token')) return t.oauthMissing;
  return value;
}

const cardStyle: React.CSSProperties = { border: '1px solid #e5e7eb', borderRadius: 12, padding: 12, background: '#fff' };

function Button({ children, onClick, disabled, primary = false }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; primary?: boolean }) {
  return <button type="button" onClick={onClick} disabled={disabled} style={{ border: primary ? '1px solid #1d4ed8' : '1px solid #d1d5db', borderRadius: 8, padding: '8px 11px', fontSize: 13, cursor: disabled ? 'not-allowed' : 'pointer', background: primary ? '#2563eb' : '#fff', color: primary ? '#fff' : '#111827', opacity: disabled ? 0.55 : 1 }}>{children}</button>;
}

function StatusCards({ status }: { status: SyncStatusSnapshot }) {
  const rows = useMemo(() => (['chatgpt', 'claude'] as const).map((platform) => ({ platform, label: platform === 'chatgpt' ? 'ChatGPT' : 'Claude', ...status.byPlatform[platform] })), [status]);
  return <>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
      <div style={cardStyle}><div style={{ color: '#6b7280', fontSize: 12 }}>{t.queued}</div><strong style={{ fontSize: 22 }}>{status.queued}</strong></div>
      <div style={cardStyle}><div style={{ color: '#6b7280', fontSize: 12 }}>{t.uploading}</div><strong style={{ fontSize: 22 }}>{status.inProgress}</strong></div>
      <div style={cardStyle}><div style={{ color: '#6b7280', fontSize: 12 }}>{t.failed}</div><strong style={{ fontSize: 22, color: status.failed ? '#b91c1c' : undefined }}>{status.failed}</strong></div>
    </div>
    <div style={{ ...cardStyle, display: 'grid', gap: 8 }}><strong style={{ fontSize: 14 }}>{t.discovered}</strong>{rows.map((row) => <div key={row.platform} style={{ display: 'flex', justifyContent: 'space-between', color: '#374151', fontSize: 13 }}><span>{row.label}</span><span>{row.conversations} {t.conversations} / {row.scopes} {t.spaces}</span></div>)}</div>
  </>;
}

export function Dashboard({ compact = false }: DashboardProps) {
  const [status, setStatus] = useState<SyncStatusSnapshot>();
  const [busy, setBusy] = useState<string>();
  const [message, setMessage] = useState<string>();
  const refresh = useCallback(async () => {
    try { const response = await sendRuntime({ type: 'get_status' }); if (isStatusResponse(response)) setStatus(response.status); else if (!response.ok) setMessage(response.error); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  }, []);
  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 2_000); return () => window.clearInterval(timer); }, [refresh]);
  const run = useCallback(async (name: string, action: () => Promise<void>) => { setBusy(name); setMessage(undefined); try { await action(); await refresh(); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); } finally { setBusy(undefined); } }, [refresh]);
  const connect = () => run('connect', async () => { const response = await sendRuntime({ type: 'connect_drive' }); if (!response.ok) throw new Error(response.error); });
  const startInitial = () => { if (!window.confirm(t.confirm)) return; void run('initial', async () => { const response = await sendRuntime({ type: 'start_initial_backup' }); if (!response.ok) throw new Error(response.error); }); };
  const togglePause = () => run('pause', async () => { const response = await sendRuntime({ type: status?.paused ? 'resume_sync' : 'pause_sync' }); if (!response.ok) throw new Error(response.error); });
  const retry = () => run('retry', async () => { const response = await sendRuntime({ type: 'retry_failed' }); if (!response.ok) throw new Error(response.error); });
  const syncNow = () => run('now', async () => { const response = await sendRuntime({ type: 'sync_now' }); if (!response.ok) throw new Error(response.error); });
  const consent = status?.consentGranted === true;
  return <main lang="zh-CN" style={{ width: compact ? 360 : 'auto', minHeight: compact ? undefined : '100vh', boxSizing: 'border-box', padding: compact ? 14 : 28, maxWidth: compact ? undefined : 860, margin: compact ? 0 : '0 auto', fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', color: '#111827', background: compact ? '#f9fafb' : '#f3f4f6' }}>
    <header style={{ marginBottom: 14 }}><div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'start' }}><div><h1 style={{ fontSize: compact ? 18 : 24, margin: 0 }}>AI Chat Backup</h1><p style={{ margin: '5px 0 0', color: '#6b7280', fontSize: 13 }}>{t.subtitle}</p></div>{!compact && <span style={{ fontSize: 12, color: '#6b7280' }}>{t.devMode}</span>}</div></header>
    <section style={{ ...cardStyle, marginBottom: 10 }}><div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}><div><strong style={{ fontSize: 14 }}>Google Drive</strong><div style={{ color: status?.drive.connected ? '#047857' : '#b45309', fontSize: 13, marginTop: 3 }}>{status?.drive.connected ? `${t.connected} - ${status.drive.rootFolderName}` : t.disconnected}</div></div><Button primary={!status?.drive.connected} onClick={connect} disabled={busy !== undefined}>{busy === 'connect' ? t.connecting : status?.drive.connected ? t.reconnect : t.connect}</Button></div></section>
    {status && <StatusCards status={status} />}
    <section style={{ ...cardStyle, marginTop: 10 }}>{!consent && <p style={{ margin: '0 0 10px', fontSize: 12, lineHeight: 1.5, color: '#92400e' }}>{t.consent}</p>}{status?.paused && status.pausedReason && <p style={{ margin: '0 0 10px', fontSize: 12, color: '#991b1b' }}>{t.paused}: {localizeMessage(status.pausedReason)}</p>}<div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}><Button primary onClick={startInitial} disabled={busy !== undefined || !status?.drive.connected}>{busy === 'initial' ? t.starting : t.start}</Button><Button onClick={syncNow} disabled={busy !== undefined || !consent}>{busy === 'now' ? t.capturing : t.syncCurrent}</Button><Button onClick={togglePause} disabled={busy !== undefined || !consent}>{busy === 'pause' ? t.working : status?.paused ? t.resume : t.pause}</Button><Button onClick={retry} disabled={busy !== undefined || !status?.failed}>{busy === 'retry' ? t.retrying : t.retry}</Button>{compact && <Button onClick={() => void chrome.runtime.openOptionsPage()} disabled={busy !== undefined}>{t.console}</Button>}</div><p style={{ color: '#6b7280', fontSize: 12, margin: '10px 0 0' }}>{t.lastSync}: {formatTime(status?.lastSuccessfulSyncAt)}</p></section>
    <aside style={{ marginTop: 10, fontSize: 12, lineHeight: 1.55, color: '#4b5563' }}>{t.privacy}</aside>
    {message && <div role="status" style={{ marginTop: 10, padding: 10, borderRadius: 8, background: '#fef2f2', color: '#991b1b', fontSize: 13 }}>{localizeMessage(message)}</div>}
  </main>;
}
