import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSnbt } from "../src/engine/snbtParser";
import { serialize } from "../src/engine/snbtSerializer";
import { SnbtSyntaxError } from "../src/engine/snbtLexer";
import { compound, get, getList, javaDoubleToString, javaFloatToString, list, nodesEqual, set, setNumber, str, type CompoundNode } from "../src/engine/snbtNodes";
import { CORPUS, changedLines, hasCorpus, readTree } from "./helpers";

test("corpus: every file round-trips byte-for-byte, verbatim and canonical", { skip: !hasCorpus && "no corpus" }, () => {
	const files = readTree(CORPUS);
	assert.ok(files.size > 5);
	for (const [path, src] of files) {
		const doc = parseSnbt(src, path);
		assert.equal(serialize(doc), src, `${path} verbatim`);
		assert.equal(serialize(doc, { canonical: true }), src, `${path} canonical (matches FTB's writer)`);
	}
});

test("corpus: an edit changes only the edited line", { skip: !hasCorpus && "no corpus" }, () => {
	const src = readTree(CORPUS).get("chapters/malum.snbt")!;
	const doc = parseSnbt(src);
	const quest = getList(doc.root as CompoundNode, "quests")!.items[3] as CompoundNode;
	setNumber(quest, "x", 42.5);
	const d = changedLines(src, serialize(doc));
	assert.equal(d.removed.length, 1);
	assert.equal(d.added.length, 1);
	assert.match(d.added[0]!, /^\t\t\tx: 42\.5d$/);
});

test("corpus: inserting a key adds exactly one line in sorted position", { skip: !hasCorpus && "no corpus" }, () => {
	const src = readTree(CORPUS).get("chapters/eidolon.snbt")!;
	const doc = parseSnbt(src);
	const quest = getList(doc.root as CompoundNode, "quests")!.items[1] as CompoundNode;
	set(quest, "shape", str("hexagon"));
	const out = serialize(doc);
	const d = changedLines(src, out);
	assert.deepEqual(d.removed, []);
	assert.deepEqual(d.added, ['\t\t\tshape: "hexagon"']);
	assert.deepEqual((parseSnbt(out).root as CompoundNode).entries.map((e) => e.key), (doc.root as CompoundNode).entries.map((e) => e.key));
});

test("typed numbers, booleans, escapes and arrays survive", () => {
	const src = '{\n\ta: 1b\n\tb: 2s\n\tc: 3\n\td: 4L\n\te: 5.5f\n\tf: 6.0d\n\tg: true\n\th: "q\\"uo\\\\te"\n\ti: [I; 1, 2, 3]\n\t"weird:key": [ ]\n\tj: { }\n}\n';
	const doc = parseSnbt(src);
	assert.equal(serialize(doc), src);
	assert.equal(serialize(doc, { canonical: true }), src.replace("[I; 1, 2, 3]", "[I;\n\t\t1\n\t\t2\n\t\t3\n\t]"));
	const root = doc.root as CompoundNode;
	assert.deepEqual(
		root.entries.map((e) => (e.value.kind === "number" ? e.value.type : e.value.kind)),
		["b", "s", "i", "l", "f", "d", "bool", "string", "array", "list", "compound"],
	);
	assert.equal((get(root, "h") as { value: string }).value, 'q"uo\\te');
});

test("long values keep full precision", () => {
	const doc = parseSnbt("{ v: 9223372036854775807L }");
	assert.equal(serialize(doc, { canonical: true }), "{ v: 9223372036854775807L }");
});

test("Java number formatting", () => {
	assert.equal(javaDoubleToString(2), "2.0");
	assert.equal(javaDoubleToString(-15), "-15.0");
	assert.equal(javaDoubleToString(5.716156462585047), "5.716156462585047");
	assert.equal(javaDoubleToString(0.001), "0.001");
	assert.equal(javaDoubleToString(0.0001), "1.0E-4");
	assert.equal(javaDoubleToString(1e7), "1.0E7");
	assert.equal(javaDoubleToString(12345678.9), "1.23456789E7");
	assert.equal(javaDoubleToString(-0), "-0.0");
	assert.equal(javaFloatToString(0.1), "0.1");
	assert.equal(javaFloatToString(1.5), "1.5");
});

test("new nodes follow FTB layout rules", () => {
	const doc = parseSnbt("{\n\tquests: [ ]\n}\n");
	const quests = getList(doc.root as CompoundNode, "quests")!;
	quests.items.push(compound({ id: str("A"), tasks: list([compound({ id: str("B"), item: compound({ count: setInt(1), id: str("x:y") }, true) })]) }));
	assert.equal(
		serialize(doc),
		'{\n\tquests: [{\n\t\tid: "A"\n\t\ttasks: [{\n\t\t\tid: "B"\n\t\t\titem: { count: 1, id: "x:y" }\n\t\t}]\n\t}]\n}\n',
	);
	quests.items.push(compound({ id: str("C") }));
	assert.match(serialize(doc), /^\{\n\tquests: \[\n\t\t\{\n\t\t\tid: "A"/);
});

function setInt(n: number) {
	return { kind: "number" as const, type: "i" as const, text: String(n) };
}

test("syntax errors carry line and column", () => {
	assert.throws(
		() => parseSnbt("{\n\ta: 1\n\tb: }\n", "x.snbt"),
		(e: unknown) => e instanceof SnbtSyntaxError && e.line === 3 && e.column === 5 && e.message.startsWith("x.snbt:3:5"),
	);
	assert.throws(() => parseSnbt("{ a: 1, a: 2 }"), /Duplicate key/);
	assert.throws(() => parseSnbt('{ a: "open }'), /Unterminated string/);
});

test("comma and newline separators are both accepted", () => {
	const a = parseSnbt("{ a: 1, b: [1, 2], c: { d: 1 } }");
	const b = parseSnbt("{\n a: 1\n b: [\n 1\n 2\n ]\n c: {\n d: 1\n }\n}");
	assert.ok(nodesEqual(a.root, b.root));
});
