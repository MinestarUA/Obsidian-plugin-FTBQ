import { syntaxError, tokenize, type Token } from "./snbtLexer";
import type { ArrayNode, CompoundEntry, CompoundNode, ListNode, NumberNode, NumberType, Origin, SnbtDocument, SnbtNode } from "./snbtNodes";

const NUMBER_RE = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)([bBsSlLfFdD]?)$/;

/** Parses SNBT text into a CST that remembers its source layout. */
export function parseSnbt(source: string, file?: string): SnbtDocument {
	const tokens = tokenize(source, file);
	let pos = 0;

	const peek = (): Token => tokens[pos]!;
	const next = (): Token => tokens[pos++]!;
	const fail = (t: Token, msg: string): never => {
		throw syntaxError(source, t.start, msg, file);
	};
	const expect = (type: Token["type"]): Token => {
		const t = next();
		if (t.type !== type) fail(t, `Expected '${type}' but found '${t.value || t.type}'`);
		return t;
	};

	const origin = (start: number, end: number, extra?: Partial<Origin>): Origin => ({
		source,
		start,
		end,
		base: lineIndent(source, start),
		inline: !hasLineBreak(source, start, end),
		...extra,
	});

	function parseValue(): SnbtNode {
		const t = peek();
		switch (t.type) {
			case "{":
				return parseCompound();
			case "[":
				return parseList();
			case "string":
				next();
				return { kind: "string", value: t.value, origin: origin(t.start, t.end, { value: t.value }) };
			case "word": {
				next();
				return parseWord(t);
			}
			default:
				return fail(t, `Unexpected '${t.value || t.type}'`);
		}
	}

	function parseWord(t: Token): SnbtNode {
		if (t.value === "true" || t.value === "false") {
			const value = t.value === "true";
			return { kind: "bool", value, origin: origin(t.start, t.end, { value }) };
		}
		const m = NUMBER_RE.exec(t.value);
		if (m) {
			const suffix = m[2]!.toLowerCase();
			let type: NumberType;
			if (suffix) type = suffix as NumberType;
			else type = /[.eE]/.test(m[1]!) ? "d" : "i";
			const text = m[1]!;
			return { kind: "number", type, text, origin: origin(t.start, t.end, { value: text }) };
		}
		// Unquoted string value: legal in SNBT, kept as a string.
		return { kind: "string", value: t.value, origin: origin(t.start, t.end, { value: t.value }) };
	}

	function parseCompound(): CompoundNode {
		const open = expect("{");
		const entries: CompoundEntry[] = [];
		const seen = new Set<string>();
		for (;;) {
			const t = peek();
			if (t.type === "}") break;
			if (t.type !== "word" && t.type !== "string") fail(t, `Expected key or '}' but found '${t.value || t.type}'`);
			next();
			if (seen.has(t.value)) fail(t, `Duplicate key '${t.value}'`);
			seen.add(t.value);
			expect(":");
			entries.push({ key: t.value, value: parseValue() });
			if (peek().type === ",") next();
		}
		const close = expect("}");
		return {
			kind: "compound",
			entries,
			origin: origin(open.start, close.end, { children: entries.map((e) => e.value), keys: entries.map((e) => e.key) }),
		};
	}

	function parseList(): ListNode | ArrayNode {
		const open = expect("[");
		const a = tokens[pos]!;
		const b = tokens[pos + 1]!;
		if (a.type === "word" && b.type === ";" && (a.value === "B" || a.value === "I" || a.value === "L")) {
			pos += 2;
			const items: NumberNode[] = [];
			while (peek().type !== "]") {
				const v = parseValue();
				if (v.kind !== "number") fail(tokens[pos - 1]!, `Typed array [${a.value};] may only contain numbers`);
				items.push(v as NumberNode);
				if (peek().type === ",") next();
			}
			const close = expect("]");
			return { kind: "array", arrayType: a.value, items, origin: origin(open.start, close.end, { children: items.slice() }) };
		}
		const items: SnbtNode[] = [];
		while (peek().type !== "]") {
			if (peek().type === "eof") fail(peek(), "Unterminated list");
			items.push(parseValue());
			if (peek().type === ",") next();
		}
		const close = expect("]");
		return { kind: "list", items, origin: origin(open.start, close.end, { children: items.slice() }) };
	}

	const first = peek();
	if (first.type === "eof") fail(first, "Empty document");
	const root = parseValue();
	const last = peek();
	if (last.type !== "eof") fail(last, `Unexpected '${last.value}' after root value`);
	const rootStart = root.origin!.start;
	const rootEnd = root.origin!.end;
	return { source, leading: source.slice(0, rootStart), root, trailing: source.slice(rootEnd) };
}

function hasLineBreak(s: string, start: number, end: number): boolean {
	const i = s.indexOf("\n", start);
	return i >= 0 && i < end;
}

/** Number of leading tabs on the line containing `offset` (4 spaces count as one tab). */
export function lineIndent(s: string, offset: number): number {
	const lineStart = s.lastIndexOf("\n", offset - 1) + 1;
	let tabs = 0;
	let spaces = 0;
	for (let i = lineStart; i < offset; i++) {
		const c = s[i];
		if (c === "\t") tabs++;
		else if (c === " ") spaces++;
		else break;
	}
	return tabs + Math.floor(spaces / 4);
}
