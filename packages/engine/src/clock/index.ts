// World clock — turn-based time arithmetic.
// Authoritative format in branches.state.time:
// { iso, hhmm, day_of_week, day_counter, week_counter, tick_minutes }

const DOW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type DayOfWeek = (typeof DOW)[number];

export type WorldTime = {
	iso: string;
	hhmm: string;
	day_of_week: DayOfWeek;
	day_counter: number;
	week_counter: number;
	tick_minutes: number;
};

/** Parse a human tick string like "3min" / "1h" / "30s" into integer minutes. */
export function parseTickMinutes(spec: string | number | undefined): number {
	if (typeof spec === "number") return Math.max(1, Math.round(spec));
	if (!spec) return 1;
	const m = /^(\d+)\s*(s|sec|second|seconds|m|min|minute|minutes|h|hr|hour|hours|d|day|days)?$/i.exec(
		String(spec).trim(),
	);
	if (!m) return 1;
	const n = parseInt(m[1], 10);
	const unit = (m[2] ?? "min").toLowerCase();
	if (unit.startsWith("s")) return Math.max(1, Math.round(n / 60));
	if (unit.startsWith("h")) return n * 60;
	if (unit.startsWith("d")) return n * 24 * 60;
	return n;
}

function isoDayOfWeek(iso: string): DayOfWeek {
	const d = new Date(iso);
	return DOW[d.getUTCDay()];
}

function isoToHHMM(iso: string): string {
	const d = new Date(iso);
	const hh = String(d.getUTCHours()).padStart(2, "0");
	const mm = String(d.getUTCMinutes()).padStart(2, "0");
	return `${hh}:${mm}`;
}

export function initWorldTime(opts: {
	start?: string;
	tick_per_turn?: string | number;
}): WorldTime {
	const tick_minutes = parseTickMinutes(opts.tick_per_turn);
	const startIso = opts.start ?? new Date().toISOString();
	const iso = new Date(startIso).toISOString();
	return {
		iso,
		hhmm: isoToHHMM(iso),
		day_of_week: isoDayOfWeek(iso),
		day_counter: 0,
		week_counter: 0,
		tick_minutes,
	};
}

/** Advance by N ticks (each tick = tick_minutes). Optionally scale by a
 *  biome time_dilation multiplier (Ask 1). Returns the new WorldTime;
 *  callers write it back into branches.state.time. */
export function advanceWorldTime(
	current: WorldTime,
	ticks = 1,
	dilation = 1,
): WorldTime {
	const minutesToAdd = current.tick_minutes * ticks * dilation;
	const d = new Date(current.iso);
	const prevDay = Math.floor(d.getTime() / (24 * 60 * 60 * 1000));
	d.setUTCMinutes(d.getUTCMinutes() + minutesToAdd);
	const nextIso = d.toISOString();
	const nextDay = Math.floor(d.getTime() / (24 * 60 * 60 * 1000));
	const daysAdded = nextDay - prevDay;
	return {
		...current,
		iso: nextIso,
		hhmm: isoToHHMM(nextIso),
		day_of_week: isoDayOfWeek(nextIso),
		day_counter: current.day_counter + Math.max(0, daysAdded),
		week_counter:
			current.week_counter + Math.floor((current.day_counter + daysAdded) / 7) - Math.floor(current.day_counter / 7),
	};
}

/** Safe expression evaluator for option `condition:` / template `{{…}}`.
 *  Grammar (lowest → highest precedence):
 *    ternary:   `a ? b : c`                          (right-associative)
 *    or:        `a || b`
 *    and:       `a && b`
 *    unary-not: `!a`
 *    compare:   `== != < <= > >=`
 *    add:       `+ -`
 *    mul:       `* /`
 *    unary-neg: `-a`
 *    atom:      literal | ident[.path] | ident(args) | (expr)
 *  Functions:   rand(), rand_int(lo,hi), dice(n,s), min/max(...),
 *               pick(...), has(coll,val), length(x).
 *  RNG is injectable. Callers should pass a seeded rng (by
 *  branch+turn+entity) so re-renders are deterministic; omitting
 *  falls back to Math.random. */
export function evalExpression(
	expr: string,
	scope: Record<string, unknown>,
	rng?: () => number,
): unknown {
	if (!expr || !expr.trim()) return undefined;
	const tokens = tokenize(expr);
	let pos = 0;
	const rnd = rng ?? Math.random;

	function peek() {
		return tokens[pos];
	}
	function consume(kind?: string) {
		const t = tokens[pos++];
		if (kind && t?.kind !== kind) {
			throw new Error(`expected ${kind} got ${t?.kind}`);
		}
		return t;
	}

	function parseTernary(): unknown {
		const cond = parseOr();
		if (peek()?.kind === "?") {
			consume("?");
			const a = parseTernary();
			consume(":");
			const b = parseTernary();
			return truthy(cond) ? a : b;
		}
		return cond;
	}
	function parseOr(): unknown {
		let left = parseAnd();
		while (peek()?.kind === "||") {
			consume("||");
			const right = parseAnd();
			// Lazy OR: keep the first truthy value (matches JS ||).
			left = truthy(left) ? left : right;
		}
		return left;
	}
	function parseAnd(): unknown {
		let left = parseNot();
		while (peek()?.kind === "&&") {
			consume("&&");
			const right = parseNot();
			left = truthy(left) ? right : left;
		}
		return left;
	}
	function parseNot(): unknown {
		if (peek()?.kind === "!") {
			consume("!");
			return !truthy(parseNot());
		}
		return parseCmp();
	}
	function parseCmp(): unknown {
		const left = parseAdd();
		const op = peek();
		if (op && ["==", "!=", "<", "<=", ">", ">="].includes(op.kind)) {
			consume(op.kind);
			const right = parseAdd();
			return compare(op.kind, left, right);
		}
		return left;
	}
	function parseAdd(): unknown {
		let left = parseMul();
		while (peek()?.kind === "+" || peek()?.kind === "-") {
			const op = consume().kind;
			const right = parseMul();
			left = op === "+" ? numAdd(left, right) : numSub(left, right);
		}
		return left;
	}
	function parseMul(): unknown {
		let left = parseUnary();
		while (peek()?.kind === "*" || peek()?.kind === "/") {
			const op = consume().kind;
			const right = parseUnary();
			left = op === "*" ? numMul(left, right) : numDiv(left, right);
		}
		return left;
	}
	function parseUnary(): unknown {
		if (peek()?.kind === "-") {
			consume("-");
			const v = parseUnary();
			return -Number(v);
		}
		return parseAtom();
	}
	function parseAtom(): unknown {
		const t = peek();
		if (!t) throw new Error("unexpected end");
		if (t.kind === "(") {
			consume("(");
			const v = parseTernary();
			consume(")");
			return v;
		}
		if (t.kind === "string" || t.kind === "number") {
			consume();
			return t.value;
		}
		if (t.kind === "ident") {
			consume();
			if (t.value === "true") return true;
			if (t.value === "false") return false;
			if (t.value === "null") return null;
			if (t.value === "undefined") return undefined;
			// Function call?
			if (peek()?.kind === "(") {
				return callFunction(t.value);
			}
			// Bracket-subscript chain: `x[key]...[key]` for hyphenated
			// keys that can't be dot-paths. Mix with further dots via
			// the existing lookupPath on the initial ident.
			let cur: unknown = lookupPath(scope, t.value);
			while (peek()?.kind === "[") {
				consume("[");
				const key = parseTernary();
				consume("]");
				if (cur == null) return undefined;
				cur = (cur as Record<string, unknown>)[String(key)];
			}
			return cur;
		}
		throw new Error(`unexpected token ${t.kind}`);
	}
	function parseArgs(): unknown[] {
		consume("(");
		const out: unknown[] = [];
		if (peek()?.kind === ")") {
			consume(")");
			return out;
		}
		out.push(parseTernary());
		while (peek()?.kind === ",") {
			consume(",");
			out.push(parseTernary());
		}
		consume(")");
		return out;
	}
	function callFunction(name: string): unknown {
		const args = parseArgs();
		switch (name) {
			case "rand":
				return rnd();
			case "rand_int": {
				const lo = Math.floor(Number(args[0] ?? 0));
				const hi = Math.floor(Number(args[1] ?? 0));
				const a = Math.min(lo, hi), b = Math.max(lo, hi);
				return Math.floor(rnd() * (b - a + 1)) + a;
			}
			case "dice": {
				const n = Math.max(0, Math.floor(Number(args[0] ?? 1)));
				const s = Math.max(1, Math.floor(Number(args[1] ?? 6)));
				let total = 0;
				for (let i = 0; i < n; i++) total += Math.floor(rnd() * s) + 1;
				return total;
			}
			case "min":
				return args.reduce((m: number, v) => Math.min(m, Number(v)), Infinity);
			case "max":
				return args.reduce((m: number, v) => Math.max(m, Number(v)), -Infinity);
			case "pick":
				if (args.length === 0) return undefined;
				return args[Math.floor(rnd() * args.length)];
			case "has": {
				const coll = args[0];
				const val = args[1];
				if (Array.isArray(coll)) return coll.some((x) => x === val || String(x) === String(val));
				if (coll && typeof coll === "object")
					return Object.prototype.hasOwnProperty.call(coll, String(val));
				if (typeof coll === "string") return coll.includes(String(val));
				return false;
			}
			case "length": {
				const v = args[0];
				if (Array.isArray(v) || typeof v === "string") return v.length;
				if (v && typeof v === "object") return Object.keys(v).length;
				return 0;
			}
			default:
				throw new Error(`unknown function: ${name}`);
		}
	}
	try {
		return parseTernary();
	} catch {
		return undefined;
	}
}

/** Boolean wrapper around evalExpression — existing callers. */
export function evalCondition(
	expr: string,
	scope: Record<string, unknown>,
	rng?: () => number,
): boolean {
	if (!expr || !expr.trim()) return true;
	const v = evalExpression(expr, scope, rng);
	return truthy(v);
}

function truthy(v: unknown): boolean {
	if (v == null || v === false || v === 0 || v === "") return false;
	if (typeof v === "number" && Number.isNaN(v)) return false;
	return Boolean(v);
}

function numAdd(a: unknown, b: unknown): unknown {
	// If either side is a string, concatenate (predictable template
	// authoring). Otherwise, numeric.
	if (typeof a === "string" || typeof b === "string") {
		return String(a ?? "") + String(b ?? "");
	}
	return Number(a) + Number(b);
}
function numSub(a: unknown, b: unknown): number {
	return Number(a) - Number(b);
}
function numMul(a: unknown, b: unknown): number {
	return Number(a) * Number(b);
}
function numDiv(a: unknown, b: unknown): number {
	const d = Number(b);
	if (d === 0) return 0; // never throw from template; 0 is the forgiving default
	return Number(a) / d;
}

function compare(op: string, a: unknown, b: unknown): boolean {
	if (op === "==") return a === b || String(a) === String(b);
	if (op === "!=") return !(a === b || String(a) === String(b));
	// Cast for ordering — strings lexicographic; numbers numeric.
	if (typeof a === "number" && typeof b === "number") {
		switch (op) {
			case "<":
				return a < b;
			case "<=":
				return a <= b;
			case ">":
				return a > b;
			case ">=":
				return a >= b;
		}
	}
	const sa = String(a);
	const sb = String(b);
	switch (op) {
		case "<":
			return sa < sb;
		case "<=":
			return sa <= sb;
		case ">":
			return sa > sb;
		case ">=":
			return sa >= sb;
	}
	return false;
}

function lookupPath(scope: Record<string, unknown>, path: string): unknown {
	const parts = path.split(".");
	let cur: unknown = scope;
	for (const p of parts) {
		if (cur == null || typeof cur !== "object") return undefined;
		cur = (cur as Record<string, unknown>)[p];
	}
	return cur;
}

type Token =
	| { kind: "string"; value: string }
	| { kind: "number"; value: number }
	| { kind: "ident"; value: string }
	| { kind: "(" }
	| { kind: ")" }
	| { kind: "[" }
	| { kind: "]" }
	| { kind: "," }
	| { kind: "?" }
	| { kind: ":" }
	| { kind: "+" | "-" | "*" | "/" }
	| { kind: "==" | "!=" | "<" | "<=" | ">" | ">=" }
	| { kind: "&&" | "||" | "!" };

function tokenize(src: string): Token[] {
	const out: Token[] = [];
	let i = 0;
	while (i < src.length) {
		const c = src[i];
		if (/\s/.test(c)) {
			i++;
			continue;
		}
		if (c === "(" || c === ")" || c === "[" || c === "]") {
			out.push({ kind: c });
			i++;
			continue;
		}
		if (c === "," || c === "?" || c === ":") {
			out.push({ kind: c });
			i++;
			continue;
		}
		if (c === "+" || c === "-" || c === "*" || c === "/") {
			out.push({ kind: c });
			i++;
			continue;
		}
		if (c === "&" && src[i + 1] === "&") {
			out.push({ kind: "&&" });
			i += 2;
			continue;
		}
		if (c === "|" && src[i + 1] === "|") {
			out.push({ kind: "||" });
			i += 2;
			continue;
		}
		if (c === "=" && src[i + 1] === "=") {
			out.push({ kind: "==" });
			i += 2;
			continue;
		}
		if (c === "!" && src[i + 1] === "=") {
			out.push({ kind: "!=" });
			i += 2;
			continue;
		}
		if (c === "<" && src[i + 1] === "=") {
			out.push({ kind: "<=" });
			i += 2;
			continue;
		}
		if (c === ">" && src[i + 1] === "=") {
			out.push({ kind: ">=" });
			i += 2;
			continue;
		}
		if (c === "<") {
			out.push({ kind: "<" });
			i++;
			continue;
		}
		if (c === ">") {
			out.push({ kind: ">" });
			i++;
			continue;
		}
		if (c === "!") {
			out.push({ kind: "!" });
			i++;
			continue;
		}
		if (c === '"' || c === "'") {
			const quote = c;
			let j = i + 1;
			let value = "";
			while (j < src.length && src[j] !== quote) {
				if (src[j] === "\\" && j + 1 < src.length) {
					value += src[j + 1];
					j += 2;
				} else {
					value += src[j];
					j++;
				}
			}
			if (src[j] !== quote) throw new Error(`unterminated string`);
			out.push({ kind: "string", value });
			i = j + 1;
			continue;
		}
		if (/[0-9]/.test(c)) {
			let j = i;
			while (j < src.length && /[0-9.]/.test(src[j])) j++;
			out.push({ kind: "number", value: parseFloat(src.slice(i, j)) });
			i = j;
			continue;
		}
		if (/[a-zA-Z_]/.test(c)) {
			let j = i;
			while (j < src.length && /[a-zA-Z_0-9.]/.test(src[j])) j++;
			out.push({ kind: "ident", value: src.slice(i, j) });
			i = j;
			continue;
		}
		throw new Error(`unexpected char ${c} at ${i}`);
	}
	return out;
}
