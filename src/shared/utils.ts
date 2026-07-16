import type { JsonValue, Scope } from "./types";

/**
 * Deterministically serialise JSON-like data. Object keys are sorted while
 * array order is retained, making the result suitable for semantic hashing.
 */
export function stableStringify(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`;
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Make a readable, filesystem-safe component for a Drive name. */
export function slugify(value: string, maxLength = 80): string {
  const result = value
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");

  return (result || "untitled").slice(0, maxLength);
}

export function makeConversationKey(
  platform: Scope["platform"],
  scopeKey: string,
  sourceId: string
): string {
  return `${platform}:${scopeKey}:${sourceId}`;
}

export function hashProjection(
  value: unknown,
  ignoredKeys: readonly string[] = ["capturedAt", "semanticHash"]
): JsonValue {
  const ignored = new Set(ignoredKeys);

  const visit = (input: unknown): JsonValue => {
    if (input === null || typeof input === "string" || typeof input === "number" || typeof input === "boolean") {
      return input;
    }
    if (Array.isArray(input)) {
      return input.map((item) => visit(item));
    }
    if (typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .filter(([key]) => !ignored.has(key))
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, visit(item)])
      );
    }
    return String(input);
  };

  return visit(value);
}
