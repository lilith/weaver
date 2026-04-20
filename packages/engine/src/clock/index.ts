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

/** Minimal safe expression evaluator for option `condition:` strings.
 *  Supports: path lookup (a.b.c), string / number / bool / null literals,
 *  ==, !=, <, <=, >, >=, &&, ||, !, parens. No function calls, no
 *  arithmetic beyond comparison. Returns boolean. */
export function evalCondition(
	expr: string,
	scope: Record<string, unknown>,
): boolean {
	if (!expr || !expr.trim()) return true;
	const tokens = tokenize(expr);
	let pos = 0;

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

	function parseOr(): unknown {
		let left = parseAnd();
		while (peek()?.kind === "||") {
			consume("||");
			const right = parseAnd();
			left = Boolean(left) || Boolean(right);
		}
		return left;
	}
	function parseAnd(): unknown {
		let left = parseNot();
		while (peek()?.kind === "&&") {
			consume("&&");
			const right = parseNot();
			left = Boolean(left) && Boolean(right);
		}
		return left;
	}
	function parseNot(): unknown {
		if (peek()?.kind === "!") {
			consume("!");
			return !Boolean(parseNot());
		}
		return parseCmp();
	}
	function parseCmp(): unknown {
		const left = parseAtom();
		const op = peek();
		if (op && ["==", "!=", "<", "<=", ">", ">="].includes(op.kind)) {
			consume(op.kind);
			const right = parseAtom();
			return compare(op.kind, left, right);
		}
		return left;
	}
	function parseAtom(): unknown {
		const t = peek();
		if (!t) throw new Error("unexpected end");
		if (t.kind === "(") {
			consume("(");
			const v = parseOr();
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
			return lookupPath(scope, t.value);
		}
		throw new Error(`unexpected token ${t.kind}`);
	}
	try {
		const v = parseOr();
		return Boolean(v);
	} catch {
		return false;
	}
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
		if (c === "(" || c === ")") {
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
