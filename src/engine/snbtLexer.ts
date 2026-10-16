/**
 * Tokenizer for FTB-flavoured SNBT.
 *
 * Whitespace is not emitted as tokens: every token records its offsets, so the parser can
 * recover the exact text between two tokens (`source.slice(prev.end, next.start)`).
 */

export type TokenType = "{" | "}" | "[" | "]" | ":" | "," | ";" | "string" | "word" | "eof";

export interface Token {
	type: TokenType;
	start: number;
	end: number;
	/** Decoded text for `string`, raw text for `word`. */
	value: string;
}

export class SnbtSyntaxError extends Error {
	constructor(
		message: string,
		readonly offset: number,
		readonly line: number,
		readonly column: number,
		readonly file?: string,
	) {
		super(`${file ? file + ":" : ""}${line}:${column}: ${message}`);
		this.name = "SnbtSyntaxError";
	}
}

export function positionOf(source: string, offset: number): { line: number; column: number } {
	let line = 1;
	let lineStart = 0;
	for (let i = 0; i < offset && i < source.length; i++) {
		if (source.charCodeAt(i) === 10) {
			line++;
			lineStart = i + 1;
		}
	}
	return { line, column: offset - lineStart + 1 };
}

export function syntaxError(source: string, offset: number, message: string, file?: string): SnbtSyntaxError {
	const { line, column } = positionOf(source, offset);
	return new SnbtSyntaxError(message, offset, line, column, file);
}

/** Characters allowed in unquoted words (keys, numbers, booleans, bare strings). */
export function isWordChar(c: number): boolean {
	return (
		(c >= 48 && c <= 57) || // 0-9
		(c >= 65 && c <= 90) || // A-Z
		(c >= 97 && c <= 122) || // a-z
		c === 95 || // _
		c === 45 || // -
		c === 46 || // .
		c === 43 // +
	);
}

const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", "0": "\0" };

export function tokenize(source: string, file?: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	const n = source.length;
	// Byte-order mark is treated as leading whitespace.
	if (source.charCodeAt(0) === 0xfeff) i = 1;

	while (i < n) {
		const c = source.charCodeAt(i);
		// whitespace
		if (c === 32 || c === 9 || c === 10 || c === 13) {
			i++;
			continue;
		}
		const ch = source[i]!;
		if (ch === "{" || ch === "}" || ch === "[" || ch === "]" || ch === ":" || ch === "," || ch === ";") {
			tokens.push({ type: ch, start: i, end: i + 1, value: ch });
			i++;
			continue;
		}
		if (ch === '"' || ch === "'") {
			const start = i;
			let out = "";
			i++;
			for (;;) {
				if (i >= n) throw syntaxError(source, start, "Unterminated string", file);
				const d = source[i]!;
				if (d === ch) {
					i++;
					break;
				}
				if (d === "\\") {
					const e = source[i + 1];
					if (e === undefined) throw syntaxError(source, i, "Unterminated escape", file);
					if (e === "\\" || e === '"' || e === "'") out += e;
					else if (e in ESCAPES) out += ESCAPES[e];
					else if (e === "u") {
						const hex = source.slice(i + 2, i + 6);
						if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw syntaxError(source, i, "Invalid \\u escape", file);
						out += String.fromCharCode(parseInt(hex, 16));
						i += 4;
					} else throw syntaxError(source, i, `Unknown escape \\${e}`, file);
					i += 2;
					continue;
				}
				out += d;
				i++;
			}
			tokens.push({ type: "string", start, end: i, value: out });
			continue;
		}
		if (isWordChar(c)) {
			const start = i;
			while (i < n && isWordChar(source.charCodeAt(i))) i++;
			tokens.push({ type: "word", start, end: i, value: source.slice(start, i) });
			continue;
		}
		throw syntaxError(source, i, `Unexpected character '${ch}'`, file);
	}
	tokens.push({ type: "eof", start: n, end: n, value: "" });
	return tokens;
}
