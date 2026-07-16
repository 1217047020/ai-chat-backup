const OMITTED_KEYS = new Set([
  'contentHash',
  'semanticHash',
  'fetchedAt',
  'fetched_at',
  'capturedAt',
  'captured_at',
  'exportedAt',
  'exported_at',
  'downloadUrl',
  'download_url',
  'signedUrl',
  'signed_url',
]);

const VOLATILE_QUERY_KEYS = [
  /^x-amz-/i,
  /^x-goog-/i,
  /^signature$/i,
  /^expires$/i,
  /^googleaccessid$/i,
  /^token$/i,
  /^access_token$/i,
  /^key-pair-id$/i,
  /^policy$/i,
];

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function stableUrl(value: string): string {
  if (!looksLikeUrl(value)) return value;
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (VOLATILE_QUERY_KEYS.some((pattern) => pattern.test(key))) {
        url.searchParams.delete(key);
      }
    }
    url.hash = '';
    url.searchParams.sort();
    return url.toString();
  } catch {
    return value;
  }
}

function normalizeNumber(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

function normalizeValue(
  value: unknown,
  ancestors: WeakSet<object>,
): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return normalizeNumber(value);
  if (typeof value === 'string') return stableUrl(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'undefined' || typeof value === 'function') return undefined;
  if (value instanceof Date) return value.toISOString();

  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError('Cannot hash a cyclic snapshot.');
    ancestors.add(value);
    const normalized = value.map((item) => {
      const next = normalizeValue(item, ancestors);
      return next === undefined ? null : next;
    });
    ancestors.delete(value);
    return normalized;
  }

  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    if (ancestors.has(object)) throw new TypeError('Cannot hash a cyclic snapshot.');
    ancestors.add(object);
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(object).sort()) {
      if (OMITTED_KEYS.has(key)) continue;
      const next = normalizeValue(object[key], ancestors);
      if (next !== undefined) normalized[key] = next;
    }
    ancestors.delete(object);
    return normalized;
  }

  return String(value);
}

export function stableSnapshotValue(value: unknown): unknown {
  return normalizeValue(value, new WeakSet());
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(stableSnapshotValue(value));
}

export async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const buffer = new Uint8Array(bytes).buffer as ArrayBuffer;
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function semanticHash(snapshot: unknown): Promise<string> {
  return sha256(stableStringify(snapshot));
}

export async function stableIdHash(id: string, length = 12): Promise<string> {
  return (await sha256(id)).slice(0, length);
}
