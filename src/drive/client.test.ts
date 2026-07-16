import { describe, expect, it } from 'vitest';

import { appPropertiesQuery, escapeDriveQuery } from './client';

describe('Drive query helpers', () => {
  it('escapes Drive query literals', () => {
    expect(escapeDriveQuery("a'b\\c")).toBe("a\\'b\\\\c");
  });

  it('builds appProperties predicates without interpolating raw values', () => {
    const query = appPropertiesQuery({ application: 'ai-chat-backup', kind: 'root' });
    expect(query).toContain("key='application'");
    expect(query).toContain("value='ai-chat-backup'");
    expect(query).toContain("key='kind'");
  });
});
