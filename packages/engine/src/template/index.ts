// Weaver template engine — a minimal mustache-ish renderer for location
// descriptions. Supports {{var.path}}, {{#if cond}}...{{/if}},
// {{#unless cond}}...{{/unless}}. No {{#each}} yet — add on demand.
// Grammar parsed to AST once, evaluated against scoped context.
// Never uses eval or dynamic property access beyond pathlookup.

type Scope = Record<string, unknown>;

export interface TemplateContext {
  character?: Scope;
  this?: Scope;
  location?: Scope;
  world?: Scope;
}

type Node =
  | { kind: "text"; text: string }
  | { kind: "var"; path: string }
  | { kind: "if"; path: string; negate: boolean; body: Node[] };

/** Parse template source to AST. */
export function parseTemplate(source: string): Node[] {
  const nodes: Node[] = [];
  parseInto(source, 0, source.length, nodes, null);
  return nodes;
}

function parseInto(
  src: string,
  start: number,
  end: number,
  out: Node[],
  closingTag: string | null,
): number {
  let i = start;
  let text = "";
  while (i < end) {
    if (src[i] === "{" && src[i + 1] === "{") {
      if (text) {
        out.push({ kind: "text", text });
        text = "";
      }
      const tagEnd = src.indexOf("}}", i + 2);
      if (tagEnd === -1 || tagEnd >= end) throw new Error(`unterminated tag at ${i}`);
      const inner = src.slice(i + 2, tagEnd).trim();
      i = tagEnd + 2;

      if (closingTag && inner === closingTag) {
        return i;
      }

      if (inner.startsWith("#if ") || inner.startsWith("#unless ")) {
        const negate = inner.startsWith("#unless ");
        const path = inner.slice(negate ? 8 : 4).trim();
        const body: Node[] = [];
        i = parseInto(src, i, end, body, negate ? "/unless" : "/if");
        out.push({ kind: "if", path, negate, body });
      } else if (inner.startsWith("/")) {
        throw new Error(`unexpected closing tag: ${inner}`);
      } else {
        out.push({ kind: "var", path: inner });
      }
    } else {
      text += src[i];
      i++;
    }
  }
  if (text) out.push({ kind: "text", text });
  if (closingTag) throw new Error(`missing ${closingTag}`);
  return i;
}

/** Render AST against a scoped context. */
export function renderTemplate(src: string, ctx: TemplateContext): string {
  return renderNodes(parseTemplate(src), ctx);
}

function renderNodes(nodes: Node[], ctx: TemplateContext): string {
  let out = "";
  for (const n of nodes) {
    if (n.kind === "text") out += n.text;
    else if (n.kind === "var") out += stringify(lookup(ctx, n.path));
    else if (n.kind === "if") {
      const truthy = isTruthy(lookup(ctx, n.path));
      if (truthy !== n.negate) out += renderNodes(n.body, ctx);
    }
  }
  return out;
}

function lookup(ctx: TemplateContext, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = (ctx as unknown as Record<string, unknown>)[parts[0]];
  for (let i = 1; i < parts.length; i++) {
    if (cur == null) return undefined;
    const key = parts[i];
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function stringify(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function isTruthy(v: unknown): boolean {
  if (v == null || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/** Collect every {{var.path}} that appears in the source. */
export function extractVarPaths(src: string): string[] {
  const paths = new Set<string>();
  walk(parseTemplate(src));
  return Array.from(paths);
  function walk(nodes: Node[]) {
    for (const n of nodes) {
      if (n.kind === "var") paths.add(n.path);
      else if (n.kind === "if") {
        paths.add(n.path);
        walk(n.body);
      }
    }
  }
}
