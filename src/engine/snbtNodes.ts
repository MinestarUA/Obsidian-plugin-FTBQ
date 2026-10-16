/**
 * Concrete syntax tree for FTB-flavoured SNBT.
 *
 * Every node produced by the parser carries an `origin` describing exactly what it looked
 * like in the source text. The serializer re-emits a node verbatim from the source when the
 * node is still identical to its origin, and only re-formats the parts of the tree that were
 * actually mutated. That is what makes the round-trip lossless: an untouched file comes out
 * byte-for-byte identical, and an edit only changes the lines it touches.
 */

export type NumberType = "b" | "s" | "i" | "l" | "f" | "d";

export interface Origin {
	/** The text the node was parsed from (nodes may move between files). */
	source: string;
	/** Offset of the first character of the node in `Document.source`. */
	start: number;
	/** Offset one past the last character of the node. */
	end: number;
	/** Indentation (tab count) of the line the node starts on. */
	base: number;
	/** True when the node's source text contains no line break. */
	inline: boolean;
	/** Containers only: the child nodes as parsed (identity snapshot). */
	children?: readonly SnbtNode[];
	/** Compounds only: the keys as parsed. */
	keys?: readonly string[];
	/** Leaves only: the parsed value, to detect in-place mutation. */
	value?: string | boolean;
}

interface NodeBase {
	/** Set by the parser; absent on nodes created by code. Never copy it to another node. */
	origin?: Origin;
	/**
	 * Layout hint for containers created by code (or to force a re-layout):
	 * true = `{ a: 1, b: 2 }` on one line, false = one entry per line.
	 * When undefined, the parsed layout is kept, else the canonical FTB rule applies.
	 */
	inline?: boolean;
}

export interface CompoundEntry {
	key: string;
	value: SnbtNode;
}

export interface CompoundNode extends NodeBase {
	kind: "compound";
	entries: CompoundEntry[];
}

export interface ListNode extends NodeBase {
	kind: "list";
	items: SnbtNode[];
}

/** `[B; 1b, 2b]`, `[I; 1, 2]`, `[L; 1L, 2L]` */
export interface ArrayNode extends NodeBase {
	kind: "array";
	arrayType: "B" | "I" | "L";
	items: NumberNode[];
}

export interface StringNode extends NodeBase {
	kind: "string";
	value: string;
}

export interface NumberNode extends NodeBase {
	kind: "number";
	type: NumberType;
	/**
	 * Literal text without the type suffix, e.g. "2.0", "-15", "5.716156462585047".
	 * Kept as text so longs and doubles never lose precision through a JS number.
	 */
	text: string;
}

export interface BoolNode extends NodeBase {
	kind: "bool";
	value: boolean;
}

export type SnbtNode = CompoundNode | ListNode | ArrayNode | StringNode | NumberNode | BoolNode;

/** A parsed file: the root value plus the text around it. */
export interface SnbtDocument {
	source: string;
	/** Whitespace before the root value. */
	leading: string;
	root: SnbtNode;
	/** Whitespace after the root value (FTB writes a single "\n"). */
	trailing: string;
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export function compound(entries: Record<string, SnbtNode> | CompoundEntry[] = [], inline?: boolean): CompoundNode {
	const list = Array.isArray(entries)
		? entries
		: Object.keys(entries)
				.sort(javaCompare)
				.map((key) => ({ key, value: entries[key]! }));
	return { kind: "compound", entries: list, inline };
}

export function list(items: SnbtNode[] = [], inline?: boolean): ListNode {
	return { kind: "list", items, inline };
}

export function str(value: string): StringNode {
	return { kind: "string", value };
}

export function bool(value: boolean): BoolNode {
	return { kind: "bool", value };
}

export function num(type: NumberType, value: number | bigint | string): NumberNode {
	return { kind: "number", type, text: formatNumberText(type, value) };
}

export const double = (v: number) => num("d", v);
export const int = (v: number) => num("i", v);
export const long = (v: number | bigint | string) => num("l", v);

// ---------------------------------------------------------------------------
// Number formatting (mirrors Java's Double.toString / Float.toString, which FTB uses)
// ---------------------------------------------------------------------------

export function formatNumberText(type: NumberType, value: number | bigint | string): string {
	if (typeof value === "string") {
		if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(value)) throw new Error(`Invalid number literal: ${value}`);
		return value;
	}
	switch (type) {
		case "b":
		case "s":
		case "i":
		case "l": {
			if (typeof value === "number" && !Number.isInteger(value)) throw new Error(`Integer type '${type}' cannot hold ${value}`);
			const big = BigInt(value);
			const [min, max] = INT_RANGES[type];
			if (big < min || big > max) throw new Error(`Value ${value} out of range for type '${type}'`);
			return big.toString();
		}
		case "d":
			return javaDoubleToString(Number(value));
		case "f":
			return javaFloatToString(Number(value));
	}
}

const INT_RANGES: Record<"b" | "s" | "i" | "l", [bigint, bigint]> = {
	b: [-128n, 127n],
	s: [-32768n, 32767n],
	i: [-2147483648n, 2147483647n],
	l: [-9223372036854775808n, 9223372036854775807n],
};

/** Java's Double.toString: always has a fraction, scientific outside [1e-3, 1e7). */
export function javaDoubleToString(v: number): string {
	if (!Number.isFinite(v)) throw new Error(`SNBT cannot store ${v}`);
	return javaFloatingToString(v, shortestDigits(v));
}

export function javaFloatToString(v: number): string {
	if (!Number.isFinite(v)) throw new Error(`SNBT cannot store ${v}`);
	const f = Math.fround(v);
	for (let p = 1; p <= 9; p++) {
		const s = f.toPrecision(p);
		if (Math.fround(Number(s)) === f) return javaFloatingToString(f, Number(s).toString());
	}
	return javaFloatingToString(f, f.toString());
}

function shortestDigits(v: number): string {
	return v.toString(); // JS already yields the shortest round-tripping representation.
}

function javaFloatingToString(v: number, jsRepr: string): string {
	if (v === 0) return Object.is(v, -0) ? "-0.0" : "0.0";
	// Decompose the JS shortest representation into significant digits and a point position.
	const neg = v < 0;
	const [mant, exp = "0"] = (neg ? jsRepr.slice(1) : jsRepr).split("e");
	const [ip, fp = ""] = mant!.split(".");
	let digits = ip! + fp;
	let point = ip!.length + Number(exp);
	const lz = digits.length - digits.replace(/^0+/, "").length;
	digits = digits.slice(lz).replace(/0+$/, "") || "0";
	point -= lz;
	const abs = Math.abs(v);
	let out: string;
	if (abs >= 1e-3 && abs < 1e7) {
		if (point <= 0) out = "0." + "0".repeat(-point) + digits;
		else if (point >= digits.length) out = digits + "0".repeat(point - digits.length) + ".0";
		else out = digits.slice(0, point) + "." + digits.slice(point);
	} else {
		out = digits[0] + "." + (digits.slice(1) || "0") + "E" + (point - 1);
	}
	return (neg ? "-" : "") + out;
}

// ---------------------------------------------------------------------------
// Key ordering & quoting
// ---------------------------------------------------------------------------

/** Java String.compareTo (UTF-16 code unit order), which is how FTB orders keys. */
export function javaCompare(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

const BARE_KEY = /^[A-Za-z0-9._+-]+$/;

export function needsQuotes(key: string): boolean {
	return !BARE_KEY.test(key);
}

// ---------------------------------------------------------------------------
// Compound / list helpers
// ---------------------------------------------------------------------------

export function getEntry(node: CompoundNode, key: string): CompoundEntry | undefined {
	return node.entries.find((e) => e.key === key);
}

export function get(node: CompoundNode, key: string): SnbtNode | undefined {
	return getEntry(node, key)?.value;
}

export function has(node: CompoundNode, key: string): boolean {
	return node.entries.some((e) => e.key === key);
}

/**
 * Sets `key` to `value`. An existing entry keeps its position; a new one is inserted in
 * sorted position when the compound is already sorted (as FTB writes it), else appended.
 */
export function set(node: CompoundNode, key: string, value: SnbtNode): void {
	const existing = getEntry(node, key);
	if (existing) {
		existing.value = value;
		return;
	}
	const sorted = node.entries.every((e, i, a) => i === 0 || javaCompare(a[i - 1]!.key, e.key) < 0);
	if (!sorted) {
		node.entries.push({ key, value });
		return;
	}
	let i = node.entries.findIndex((e) => javaCompare(e.key, key) > 0);
	if (i < 0) i = node.entries.length;
	node.entries.splice(i, 0, { key, value });
}

export function remove(node: CompoundNode, key: string): boolean {
	const i = node.entries.findIndex((e) => e.key === key);
	if (i < 0) return false;
	node.entries.splice(i, 1);
	return true;
}

export function getString(node: CompoundNode, key: string): string | undefined {
	const v = get(node, key);
	return v?.kind === "string" ? v.value : undefined;
}

export function getNumber(node: CompoundNode, key: string): number | undefined {
	const v = get(node, key);
	return v?.kind === "number" ? Number(v.text) : undefined;
}

export function getBool(node: CompoundNode, key: string): boolean | undefined {
	const v = get(node, key);
	if (v?.kind === "bool") return v.value;
	if (v?.kind === "number" && v.type === "b") return v.text !== "0";
	return undefined;
}

export function getCompound(node: CompoundNode, key: string): CompoundNode | undefined {
	const v = get(node, key);
	return v?.kind === "compound" ? v : undefined;
}

export function getList(node: CompoundNode, key: string): ListNode | undefined {
	const v = get(node, key);
	return v?.kind === "list" ? v : undefined;
}

/** String items of a list (e.g. `dependencies`). Non-string items are ignored. */
export function stringItems(node: ListNode | undefined): string[] {
	if (!node) return [];
	return node.items.flatMap((i) => (i.kind === "string" ? [i.value] : []));
}

/**
 * Sets a numeric value, keeping the existing node (and its type) when present so the
 * entry is not re-typed by accident. Unchanged values are left untouched.
 */
export function setNumber(node: CompoundNode, key: string, value: number, type: NumberType = "d"): void {
	const existing = get(node, key);
	if (existing?.kind === "number") {
		if (Number(existing.text) === value) return;
		existing.text = formatNumberText(existing.type, value);
		return;
	}
	set(node, key, num(type, value));
}

// ---------------------------------------------------------------------------
// Cloning & conversion
// ---------------------------------------------------------------------------

/** Deep copy without origins: the clone is re-formatted canonically when serialized. */
export function cloneNode<T extends SnbtNode>(node: T): T {
	switch (node.kind) {
		case "compound":
			return { kind: "compound", inline: node.inline ?? (node.origin?.keys?.length ? node.origin.inline : undefined), entries: node.entries.map((e) => ({ key: e.key, value: cloneNode(e.value) })) } as T;
		case "list":
			return { kind: "list", inline: node.inline ?? node.origin?.inline, items: node.items.map(cloneNode) } as T;
		case "array":
			return { kind: "array", arrayType: node.arrayType, inline: node.inline ?? node.origin?.inline, items: node.items.map(cloneNode) } as T;
		case "string":
			return { kind: "string", value: node.value } as T;
		case "number":
			return { kind: "number", type: node.type, text: node.text } as T;
		case "bool":
			return { kind: "bool", value: node.value } as T;
	}
}

export type PlainValue = string | number | boolean | PlainValue[] | { [key: string]: PlainValue };

/** Lossy convenience view for reading (types are dropped; longs become numbers). */
export function toPlain(node: SnbtNode): PlainValue {
	switch (node.kind) {
		case "compound": {
			const o: { [key: string]: PlainValue } = {};
			for (const e of node.entries) o[e.key] = toPlain(e.value);
			return o;
		}
		case "list":
		case "array":
			return node.items.map(toPlain);
		case "string":
		case "bool":
			return node.value;
		case "number":
			return Number(node.text);
	}
}

/** Structural equality: kinds, types, keys (in order) and values. Layout is ignored. */
export function nodesEqual(a: SnbtNode, b: SnbtNode): boolean {
	if (a.kind !== b.kind) return false;
	switch (a.kind) {
		case "compound": {
			const bb = b as CompoundNode;
			return a.entries.length === bb.entries.length && a.entries.every((e, i) => e.key === bb.entries[i]!.key && nodesEqual(e.value, bb.entries[i]!.value));
		}
		case "list":
		case "array": {
			const bb = b as ListNode | ArrayNode;
			if (a.kind === "array" && a.arrayType !== (bb as ArrayNode).arrayType) return false;
			return a.items.length === bb.items.length && a.items.every((x, i) => nodesEqual(x, bb.items[i]!));
		}
		case "string":
		case "bool":
			return a.value === (b as StringNode | BoolNode).value;
		case "number": {
			const bb = b as NumberNode;
			return a.type === bb.type && a.text === bb.text;
		}
	}
}
