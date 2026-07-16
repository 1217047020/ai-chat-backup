import { describe, expect, it } from 'vitest';

import { semanticHash, stableStringify } from './hash';

describe('semantic snapshot hashing', () => {
  it('sorts object keys and ignores capture metadata', async () => {
    const first = {
      b: 2,
      a: 1,
      capturedAt: '2020-01-01T00:00:00.000Z',
      signedUrl:
        'https://example.test/file?X-Amz-Signature=old&name=one',
    };
    const second = {
      a: 1,
      b: 2,
      capturedAt: '2030-01-01T00:00:00.000Z',
      signedUrl:
        'https://example.test/file?name=one&X-Amz-Signature=new',
    };
    expect(stableStringify(first)).toBe(stableStringify(second));
    await expect(semanticHash(first)).resolves.toBe(await semanticHash(second));
  });

  it('retains array order because message order is meaningful', () => {
    expect(stableStringify({ messages: [1, 2] })).not.toBe(
      stableStringify({ messages: [2, 1] }),
    );
  });
});
