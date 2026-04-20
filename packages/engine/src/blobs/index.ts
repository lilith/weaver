// Blob helpers — content-addressed storage via BLAKE3.
// spec/12_BLOB_STORAGE.md §Canonicalization and §Write path.

import { blake3 } from "@noble/hashes/blake3.js";

/** Canonical JSON: sorted keys at every depth, stripped nulls, UTF-8, newline-terminated. */
export function canonicalizeJSON(value: unknown): string {
  return canonicalize(stripNulls(value)) + "\n";
}

function stripNulls(v: unknown): unknown {
  if (v === null) return undefined;
  if (Array.isArray(v)) return v.map(stripNulls).filter((x) => x !== undefined);
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object)) {
      const sub = stripNulls((v as Record<string, unknown>)[k]);
      if (sub !== undefined) out[k] = sub;
    }
    return out;
  }
  return v;
}

function canonicalize(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null) return "null";
  const t = typeof v;
  if (t === "number") {
    if (!Number.isFinite(v as number)) throw new Error("non-finite number");
    // Shortest canonical form — JSON.stringify emits sane numbers by default.
    return JSON.stringify(v);
  }
  if (t === "string" || t === "boolean") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalize).join(",") + "]";
  if (t === "object") {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const k of keys) {
      const sub = canonicalize(obj[k]);
      parts.push(JSON.stringify(k) + ":" + sub);
    }
    return "{" + parts.join(",") + "}";
  }
  throw new Error(`cannot canonicalize type ${t}`);
}

/** Canonical text: UTF-8, LF line endings, trailing whitespace stripped per line, single trailing newline. */
export function canonicalizeText(text: string): string {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/g, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n") + "\n";
}

/** BLAKE3 hash over UTF-8 bytes, hex-encoded. */
export function hashBytes(bytes: Uint8Array): string {
  return bytesToHex(blake3(bytes));
}

export function hashString(s: string): string {
  return hashBytes(new TextEncoder().encode(s));
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function utf8Encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
export function utf8Decode(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

/** Convenience: canonicalize JSON, encode, hash. Returns hash + bytes. */
export function prepareJSONBlob(value: unknown): { hash: string; bytes: Uint8Array; content_type: string } {
  const canonical = canonicalizeJSON(value);
  const bytes = utf8Encode(canonical);
  return { hash: hashBytes(bytes), bytes, content_type: "application/json" };
}

export function prepareTextBlob(text: string, content_type: string): { hash: string; bytes: Uint8Array; content_type: string } {
  const canonical = canonicalizeText(text);
  const bytes = utf8Encode(canonical);
  return { hash: hashBytes(bytes), bytes, content_type };
}

// 64KB inline cap — Convex v.bytes() handles up to 1MB, but keeping small
// payloads inline saves an R2 round-trip on every read. Real-world
// authored locations with options + canonical_features + prose typically
// land at 5–15KB; worlds-bibles around 3–8KB. Images always go to R2.
export const BLOB_INLINE_MAX_BYTES = 65536;
