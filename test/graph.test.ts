import { test } from "node:test";
import assert from "node:assert/strict";
import { QuestStore } from "../src/state/store";
import { GraphError, itemReward, itemTask } from "../src/engine/graphMutator";
import { getList, getNumber, getString, stringItems, type CompoundNode } from "../src/engine/snbtNodes";
import { parseSnbt } from "../src/engine/snbtParser";
import { CORPUS, hasCorpus, readTree } from "./helpers";

const DATA = "{\n\tgrid_scale: 0.5d\n\tversion: 13\n}\n";
const GROUPS = '{\n\tchapter_groups: [{ id: "0895E9A642D6FF5B" }]\n}\n';
const CHAPTER = `{
	default_hide_dependency_lines: false
	default_quest_shape: ""
	filename: "intro"
	group: "0895E9A642D6FF5B"
	id: "1111111111111111"
	order_index: 0
	quest_links: [ ]
	quests: [
		{
			id: "AAAAAAAAAAAAAAAA"
			tasks: [{
				id: "AAAAAAAAAAAAAAA1"
				type: "checkmark"
			}]
			x: 0.0d
			y: 0.0d
		}
		{
			dependencies: ["AAAAAAAAAAAAAAAA"]
			id: "BBBBBBBBBBBBBBBB"
			rewards: [{
				id: "BBBBBBBBBBBBBBB2"
				type: "xp"
				xp: 10
			}]
			tasks: [{
				id: "BBBBBBBBBBBBBBB1"
				item: { count: 1, id: "minecraft:dirt" }
				type: "item"
			}]
			x: 2.0d
			y: 0.0d
		}
	]
}
`;
const OTHER = `{
	filename: "other"
	group: ""
	id: "2222222222222222"
	order_index: 1
	quest_links: [{
		id: "CCCCCCCCCCCCCCC9"
		linked_quest: "BBBBBBBBBBBBBBBB"
		x: 0.0d
		y: 0.0d
	}]
	quests: [{
		dependencies: ["BBBBBBBBBBBBBBBB"]
		id: "CCCCCCCCCCCCCCCC"
		tasks: [{
			id: "CCCCCCCCCCCCCCC1"
			type: "checkmark"
		}]
		x: 1.0d
		y: 1.0d
	}]
}
`;
const LANG = `{
	chapter.1111111111111111.title: "Вступ"
	quest.AAAAAAAAAAAAAAAA.title: "Перший"
	quest.BBBBBBBBBBBBBBBB.quest_desc: [
		"рядок 1"
		"рядок 2"
	]
	quest.BBBBBBBBBBBBBBBB.title: "Другий"
}
`;

function fixture(): QuestStore {
	const store = new QuestStore({ locale: "uk_ua" });
	const errors = store.load(
		new Map([
			["data.snbt", DATA],
			["chapter_groups.snbt", GROUPS],
			["chapters/intro.snbt", CHAPTER],
			["chapters/other.snbt", OTHER],
			["lang/uk_ua.snbt", LANG],
		]),
	);
	assert.deepEqual(errors, []);
	return store;
}

test("fixture is valid", () => {
	assert.deepEqual(fixture().validate(), []);
});

test("create quest: snapped, collision-free, fresh ids, FTB layout", () => {
	const s = fixture();
	const id = s.transact("create", (m) => m.createQuest("1111111111111111", { x: 0.1, y: 0.2, title: "Новий", tasks: [itemTask("minecraft:stone", 4)] }));
	const q = s.index().get(id)!;
	assert.equal(q.kind, "quest");
	assert.notEqual(getNumber(q.node, "x") === 0 && getNumber(q.node, "y") === 0, true, "moved off the occupied origin");
	assert.ok(Number.isInteger(getNumber(q.node, "x")! * 2) && Number.isInteger(getNumber(q.node, "y")! * 2), "snapped to 0.5 grid");
	assert.equal(s.reader().getText("quest", id, "title"), "Новий");
	const text = s.textOf("chapters/intro.snbt")!;
	assert.match(text, new RegExp(`\\t\\t\\{\\n\\t\\t\\tid: "${id}"\\n\\t\\t\\ttasks: \\[\\{\\n\\t\\t\\t\\tcount: 4L\\n\\t\\t\\t\\tid: "[0-9A-F]{16}"\\n\\t\\t\\t\\titem: \\{ count: 1, id: "minecraft:stone" \\}\\n\\t\\t\\t\\ttype: "item"\\n\\t\\t\\t\\}\\]`));
	assert.deepEqual(s.validate(), []);
});

test("dependencies: cycle and self-links are rejected, cross-chapter allowed", () => {
	const s = fixture();
	assert.throws(() => s.transact("cycle", (m) => m.addDependency("AAAAAAAAAAAAAAAA", "CCCCCCCCCCCCCCCC")), /cycle: AAAAAAAAAAAAAAAA → CCCCCCCCCCCCCCCC → BBBBBBBBBBBBBBBB → AAAAAAAAAAAAAAAA/);
	assert.throws(() => s.transact("self", (m) => m.addDependency("AAAAAAAAAAAAAAAA", "AAAAAAAAAAAAAAAA")), GraphError);
	assert.equal(s.dirtyPaths().length, 0, "failed transactions leave no trace");
	s.transact("ok", (m) => m.addDependency("CCCCCCCCCCCCCCCC", "AAAAAAAAAAAAAAAA"));
	assert.deepEqual(stringItems(getList(s.index().get("CCCCCCCCCCCCCCCC")!.node, "dependencies")), ["BBBBBBBBBBBBBBBB", "AAAAAAAAAAAAAAAA"]);
	assert.match(s.textOf("chapters/other.snbt")!, /dependencies: \[\n\t\t\t"BBBBBBBBBBBBBBBB"\n\t\t\t"AAAAAAAAAAAAAAAA"\n\t\t\]/);
});

test("delete quest scrubs dependencies, quest links and lang across files", () => {
	const s = fixture();
	s.transact("delete", (m) => m.deleteQuest("BBBBBBBBBBBBBBBB"));
	const idx = s.index();
	assert.equal(idx.get("BBBBBBBBBBBBBBBB"), undefined);
	assert.equal(idx.get("BBBBBBBBBBBBBBB1"), undefined);
	assert.equal(getList(idx.get("CCCCCCCCCCCCCCCC")!.node, "dependencies"), undefined);
	assert.equal(idx.ofKind("quest_link").length, 0);
	assert.doesNotMatch(s.textOf("lang/uk_ua.snbt")!, /BBBBBBBBBBBBBBBB/);
	assert.deepEqual(s.validate(), []);
	assert.deepEqual(s.dirtyPaths(), ["chapters/intro.snbt", "chapters/other.snbt", "lang/uk_ua.snbt"]);
});

test("duplicate quest: new ids everywhere, lang copied, upstream deps kept", () => {
	const s = fixture();
	const copy = s.transact("dup", (m) => m.duplicateQuest("BBBBBBBBBBBBBBBB"));
	const q = s.index().get(copy)!;
	assert.deepEqual(stringItems(getList(q.node, "dependencies")), ["AAAAAAAAAAAAAAAA"]);
	const taskIds = getList(q.node, "tasks")!.items.map((t) => getString(t as CompoundNode, "id"));
	assert.ok(!taskIds.includes("BBBBBBBBBBBBBBB1"));
	assert.equal(s.reader().getText("quest", copy, "title"), "Другий");
	assert.deepEqual(s.reader().getText("quest", copy, "quest_desc"), ["рядок 1", "рядок 2"]);
	assert.deepEqual(s.validate(), []);
});

test("undo/redo restore files byte-for-byte", () => {
	const s = fixture();
	const before = new Map([...s.files.keys()].map((p) => [p, s.textOf(p)]));
	s.transact("move", (m) => m.moveQuest("AAAAAAAAAAAAAAAA", 5, 5));
	s.transact("reward", (m) => m.addReward("AAAAAAAAAAAAAAAA", itemReward("minecraft:diamond", 2)));
	s.transact("chapter", (m) => m.createChapter({ filename: "new_one", title: "Нова" }));
	const after = new Map([...s.files.keys()].map((p) => [p, s.textOf(p)]));
	assert.match(s.textOf("chapters/intro.snbt")!, /rewards: \[\{\n\t\t\t\tcount: 2\n\t\t\t\tid: "[0-9A-F]{16}"\n\t\t\t\titem: \{\n\t\t\t\t\tcount: 1\n/);
	s.undo();
	s.undo();
	s.undo();
	assert.deepEqual(new Map([...s.files.keys()].map((p) => [p, s.textOf(p)])), before);
	assert.equal(s.dirtyPaths().length, 0);
	s.redo();
	s.redo();
	s.redo();
	assert.deepEqual(new Map([...s.files.keys()].map((p) => [p, s.textOf(p)])), after);
});

test("rename and delete chapter", () => {
	const s = fixture();
	s.transact("rename", (m) => m.renameChapterFile("2222222222222222", "renamed"));
	assert.ok(s.files.has("chapters/renamed.snbt") && !s.files.has("chapters/other.snbt"));
	assert.deepEqual(s.validate(), []);
	s.transact("delete", (m) => m.deleteChapter("1111111111111111"));
	assert.equal(s.index().get("AAAAAAAAAAAAAAAA"), undefined);
	assert.equal(getList(s.index().get("CCCCCCCCCCCCCCCC")!.node, "dependencies"), undefined);
	assert.doesNotMatch(s.textOf("lang/uk_ua.snbt")!, /1111111111111111|AAAAAAAAAAAAAAAA/);
	assert.deepEqual(s.validate(), []);
	assert.ok(s.dirtyPaths().includes("chapters/intro.snbt"), "deletion is pending for save");
});

test("ids are immutable and moveQuestToChapter keeps the id", () => {
	const s = fixture();
	assert.throws(() => s.transact("x", (m) => m.setField("AAAAAAAAAAAAAAAA", "id", { kind: "string", value: "X" })), /immutable/);
	s.transact("move", (m) => m.moveQuestToChapter("AAAAAAAAAAAAAAAA", "2222222222222222"));
	assert.equal(s.index().get("AAAAAAAAAAAAAAAA")!.file, "chapters/other.snbt");
	assert.deepEqual(s.validate(), []);
});

test("corpus: loads, validates, and mutating every quest keeps every unknown field", { skip: !hasCorpus && "no corpus" }, () => {
	const texts = readTree(CORPUS);
	const s = new QuestStore({ locale: "uk_ua" });
	assert.deepEqual(s.load(texts), []);
	const quests = s.index().ofKind("quest");
	assert.ok(quests.length > 100);
	const keyPaths = (src: string) => {
		const out = new Set<string>();
		const walk = (n: ReturnType<typeof parseSnbt>["root"], p: string) => {
			if (n.kind === "compound") for (const e of n.entries) (out.add(p + "/" + e.key), walk(e.value, p + "/" + e.key));
			else if (n.kind === "list") n.items.forEach((i) => walk(i, p + "[]"));
		};
		walk(parseSnbt(src).root, "");
		return out;
	};
	const beforeKeys = new Map([...texts].map(([p, t]) => [p, keyPaths(t)]));
	s.transact("shift all", (m) => {
		for (const q of quests) m.moveQuest(q.id, (getNumber(q.node, "x") ?? 0) + 100, getNumber(q.node, "y") ?? 0, { snap: false, avoidCollisions: false });
	});
	for (const [p, keys] of beforeKeys) {
		const now = keyPaths(s.textOf(p)!);
		for (const k of keys) assert.ok(now.has(k), `${p}: lost ${k}`);
	}
	assert.deepEqual(s.newErrors(), []);
	s.undo();
	for (const [p, t] of texts) assert.equal(s.textOf(p), t);
});

test("schema: new tasks/rewards of every type serialize and round-trip", async () => {
	const { TASK_TYPES, REWARD_TYPES, defaultFields } = await import("../src/engine/schema");
	const store = fixture();
	const ids: string[] = [];
	store.transact("all types", (m) => {
		for (const d of TASK_TYPES) ids.push(m.addTask("AAAAAAAAAAAAAAAA", defaultFields(d)));
		for (const d of REWARD_TYPES) ids.push(m.addReward("AAAAAAAAAAAAAAAA", defaultFields(d)));
	});
	const text = store.textOf("chapters/intro.snbt")!;
	assert.equal(parseSnbt(text!).root.kind, "compound");
	for (const id of ids) assert.ok(store.index().get(id), id);
	assert.match(text, /type: "forge_energy"/);
	assert.match(text, /position: \[I; ?0, 0, 0\]/);
	assert.match(text, /observe_type: 0/);
});

test("reorder tasks, chapters, chapter groups; images; reward tables; data.snbt", () => {
	const store = fixture();
	store.transact("t", (m) => {
		const t2 = m.addTask("AAAAAAAAAAAAAAAA", itemTask("minecraft:stone"));
		m.moveChild(t2, -1);
		const q = store.index().get("AAAAAAAAAAAAAAAA")!.node;
		assert.equal(getString(getList(q, "tasks")!.items[0] as CompoundNode, "id"), t2);
		m.moveChapter("2222222222222222", -1);
		assert.equal(getNumber(store.index().get("2222222222222222")!.node, "order_index"), 0);
		assert.equal(getNumber(store.index().get("1111111111111111")!.node, "order_index"), 1);
		const g = m.createChapterGroup("Друга");
		m.moveChapterGroup(g, -1);
		m.setChapterGroup("2222222222222222", g);
		m.deleteChapterGroup(g);
		assert.equal(getString(store.index().get("2222222222222222")!.node, "group"), "");
		const i = m.addImage("1111111111111111", "minecraft:textures/block/stone.png", 1, 2);
		m.setImageField("1111111111111111", i, "alpha", undefined);
		m.duplicateImage("1111111111111111", i);
		m.removeImage("1111111111111111", i);
		const table = m.createRewardTable("loot", "Лут");
		const r = m.addTableReward(table, itemReward("minecraft:diamond"));
		m.setTableRewardField(table, r, "weight", undefined);
		m.removeTableReward(table, r);
		m.setFileField("pause_game", undefined);
	});
	assert.equal(parseSnbt(store.textOf("reward_tables/loot.snbt")!).root.kind, "compound");
	assert.match(store.textOf("chapters/intro.snbt")!, /images: \[/);
	store.undo();
	assert.equal(store.files.has("reward_tables/loot.snbt"), false);
});
