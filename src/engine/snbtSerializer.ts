import { needsQuotes, type SnbtDocument, type SnbtNode } from "./snbtNodes";

export interface SerializeOptions {
	/** Ignore source layout and print everything in FTB's canonical format. */
	canonical?: boolean;
}

/**
 * Serializes a document. Subtrees identical to what was parsed are copied verbatim from
 * the source; mutated subtrees are printed the way FTB Library's SNBT writer prints them:
 *  - tab indentation, `key: value`, one entry per line, no commas;
 *  - `{ }` / `[ ]` when empty;
 *  - single-line compounds as `{ a: 1, b: 2 }` (all nested values single-line too);
 *  - one-element lists hug their element: `["A"]`, `[{ ...multiline... }]`;
 *  - longer lists put each element on its own line.
 */
export function serialize(doc: SnbtDocument, opts: SerializeOptions = {}): string {
	return new Printer(opts).document(doc);
}

/** Prints a detached node (no source) canonically at the given indentation. */
export function serializeNode(node: SnbtNode, base = 0, inline = false): string {
	return new Printer({ canonical: true }).node(node, base, inline);
}

class Printer {
	private readonly pristine = new Map<SnbtNode, boolean>();

	constructor(private readonly opts: SerializeOptions) {}

	document(doc: SnbtDocument): string {
		const leading = doc.source ? doc.leading : "";
		const trailing = doc.source ? doc.trailing : "\n";
		return leading + this.node(doc.root, 0, false) + trailing;
	}

	node(n: SnbtNode, base: number, inlineCtx: boolean): string {
		if (!this.opts.canonical && n.origin && this.isPristine(n) && (n.origin.inline || (!inlineCtx && n.origin.base === base))) {
			return n.origin.source.slice(n.origin.start, n.origin.end);
		}
		switch (n.kind) {
			case "string":
				return quote(n.value);
			case "bool":
				return n.value ? "true" : "false";
			case "number":
				return n.text + SUFFIX[n.type];
			case "compound": {
				if (n.entries.length === 0) return "{ }";
				// An originally empty `{ }` says nothing about layout: FTB writes it that way regardless.
				const inline = inlineCtx || (n.inline ?? (n.origin?.keys?.length ? n.origin.inline : false));
				if (inline) return "{ " + n.entries.map((e) => key(e.key) + ": " + this.node(e.value, base, true)).join(", ") + " }";
				const pad = "\t".repeat(base + 1);
				let out = "{\n";
				for (const e of n.entries) out += pad + key(e.key) + ": " + this.node(e.value, base + 1, false) + "\n";
				return out + "\t".repeat(base) + "}";
			}
			case "list":
			case "array": {
				const open = n.kind === "array" ? "[" + n.arrayType + ";" : "[";
				if (n.items.length === 0) return open + " ]";
				if (n.items.length === 1) return open + this.node(n.items[0]!, base, inlineCtx) + "]";
				if (inlineCtx || n.inline === true) return open + n.items.map((i) => this.node(i, base, true)).join(", ") + "]";
				const pad = "\t".repeat(base + 1);
				let out = open + "\n";
				for (const i of n.items) out += pad + this.node(i, base + 1, false) + "\n";
				return out + "\t".repeat(base) + "]";
			}
		}
	}

	/** True when the node and its whole subtree still match what was parsed. */
	private isPristine(n: SnbtNode): boolean {
		const cached = this.pristine.get(n);
		if (cached !== undefined) return cached;
		const result = this.computePristine(n);
		this.pristine.set(n, result);
		return result;
	}

	private computePristine(n: SnbtNode): boolean {
		const o = n.origin;
		if (!o) return false;
		if (n.inline !== undefined && n.inline !== o.inline) return false;
		switch (n.kind) {
			case "string":
			case "bool":
				return n.value === o.value;
			case "number":
				return n.text === o.value;
			case "compound": {
				const keys = o.keys!;
				const children = o.children!;
				return (
					n.entries.length === keys.length &&
					n.entries.every((e, i) => e.key === keys[i] && e.value === children[i] && this.isPristine(e.value))
				);
			}
			case "list":
			case "array": {
				const children = o.children!;
				return n.items.length === children.length && n.items.every((item, i) => item === children[i] && this.isPristine(item));
			}
		}
	}
}

const SUFFIX = { b: "b", s: "s", i: "", l: "L", f: "f", d: "d" } as const;

function key(k: string): string {
	return needsQuotes(k) ? quote(k) : k;
}

export function quote(s: string): string {
	let out = '"';
	for (const ch of s) {
		switch (ch) {
			case "\\":
				out += "\\\\";
				break;
			case '"':
				out += '\\"';
				break;
			case "\n":
				out += "\\n";
				break;
			case "\r":
				out += "\\r";
				break;
			case "\t":
				out += "\\t";
				break;
			default:
				out += ch;
		}
	}
	return out + '"';
}
