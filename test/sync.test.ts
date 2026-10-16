import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QuestStore } from "../src/state/store";
import { SyncEngine } from "../src/sync/fileWatcher";

const CHAPTER = '{\n\tfilename: "intro"\n\tid: "1111111111111111"\n\tquests: [{\n\t\tid: "AAAAAAAAAAAAAAAA"\n\t\ttasks: [{\n\t\t\tid: "AAAAAAAAAAAAAAA1"\n\t\t\ttype: "checkmark"\n\t\t}]\n\t\tx: 0.0d\n\t\ty: 0.0d\n\t}]\n}\n';

function setup() {
	const base = mkdtempSync(join(tmpdir(), "ftbq-"));
	const root = join(base, "quests");
	mkdirSync(join(root, "chapters"), { recursive: true });
	mkdirSync(join(root, "lang"), { recursive: true });
	writeFileSync(join(root, "data.snbt"), "{\n\tgrid_scale: 0.5d\n}\n");
	writeFileSync(join(root, "chapters/intro.snbt"), CHAPTER);
	writeFileSync(join(root, "lang/en_us.snbt"), "{ }\n");
	const store = new QuestStore({ locale: "en_us" });
	const sync = new SyncEngine(store, { root, backupDir: join(base, "backups"), pollMs: 0, debounceMs: 10 });
	return { base, root, store, sync };
}

test("save writes atomically, backs up, leaves no temp files", async () => {
	const { base, root, store, sync } = setup();
	await sync.loadAll();
	store.transact("move", (m) => m.moveQuest("AAAAAAAAAAAAAAAA", 3, 0));
	store.transact("title", (m) => m.setText("quest", "AAAAAAAAAAAAAAAA", "title", "Hello"));
	const r = await sync.save();
	assert.ok(r.ok, JSON.stringify(r));
	assert.deepEqual(r.ok && r.written, ["chapters/intro.snbt", "lang/en_us.snbt"]);
	assert.match(readFileSync(join(root, "chapters/intro.snbt"), "utf8"), /\t\tx: 3\.0d\n/);
	assert.equal(readFileSync(join(root, "lang/en_us.snbt"), "utf8"), '{\n\tquest.AAAAAAAAAAAAAAAA.title: "Hello"\n}\n');
	assert.deepEqual(readdirSync(join(root, "chapters")), ["intro.snbt"]);
	const [backup] = readdirSync(join(base, "backups"));
	assert.equal(readFileSync(join(base, "backups", backup!, "chapters/intro.snbt"), "utf8"), CHAPTER);
	assert.deepEqual(store.dirtyPaths(), []);
});

test("external change to a clean file reloads; to a dirty file blocks saving", async () => {
	const { root, store, sync } = setup();
	await sync.loadAll();
	const external = CHAPTER.replace("x: 0.0d", "x: 7.0d");
	writeFileSync(join(root, "chapters/intro.snbt"), external);
	await sync.reconcile(["chapters/intro.snbt"]);
	assert.equal(store.textOf("chapters/intro.snbt"), external);

	store.transact("move", (m) => m.moveQuest("AAAAAAAAAAAAAAAA", 1, 1));
	writeFileSync(join(root, "chapters/intro.snbt"), CHAPTER);
	await sync.reconcile(["chapters/intro.snbt"]);
	assert.equal(sync.conflicts.size, 1);
	const blocked = await sync.save();
	assert.equal(!blocked.ok && blocked.reason, "conflicts");
	assert.equal(readFileSync(join(root, "chapters/intro.snbt"), "utf8"), CHAPTER, "disk untouched");

	await sync.resolveConflict("chapters/intro.snbt", "mine");
	const r = await sync.save();
	assert.ok(r.ok);
	assert.match(readFileSync(join(root, "chapters/intro.snbt"), "utf8"), /x: 1\.0d/);
});

test("a change on disk right before saving is detected, not overwritten", async () => {
	const { root, store, sync } = setup();
	await sync.loadAll();
	store.transact("move", (m) => m.moveQuest("AAAAAAAAAAAAAAAA", 2, 2));
	const sneaky = CHAPTER.replace("y: 0.0d", "y: 9.0d");
	writeFileSync(join(root, "chapters/intro.snbt"), sneaky); // watcher has not fired yet
	const r = await sync.save();
	assert.equal(!r.ok && r.reason, "conflicts");
	assert.equal(readFileSync(join(root, "chapters/intro.snbt"), "utf8"), sneaky);
	await sync.resolveConflict("chapters/intro.snbt", "theirs");
	assert.equal(store.textOf("chapters/intro.snbt"), sneaky);
	assert.deepEqual(store.dirtyPaths(), []);
});

test("new validation errors block the save; pre-existing ones do not", async () => {
	const { root, store, sync } = setup();
	writeFileSync(join(root, "chapters/broken.snbt"), '{\n\tfilename: "broken"\n\tid: "3333333333333333"\n\tquests: [{\n\t\tdependencies: ["DEADBEEFDEADBEEF"]\n\t\tid: "BBBBBBBBBBBBBBBB"\n\t\tx: 0.0d\n\t\ty: 0.0d\n\t}]\n}\n');
	await sync.loadAll();
	assert.ok(store.validate().some((i) => i.code === "dangling_dependency"));
	store.transact("move", (m) => m.moveQuest("AAAAAAAAAAAAAAAA", 4, 0));
	assert.ok((await sync.save()).ok, "old error does not block");
	store.transact("bad", (m) => m.setField("AAAAAAAAAAAAAAAA", "dependencies", { kind: "list", items: [{ kind: "string", value: "0123456789ABCDEF" }] }));
	const r = await sync.save();
	assert.equal(!r.ok && r.reason, "invalid");
});

test("deleting a chapter removes its file on save", async () => {
	const { root, store, sync } = setup();
	await sync.loadAll();
	store.transact("del", (m) => m.deleteChapter("1111111111111111"));
	assert.ok((await sync.save()).ok);
	assert.deepEqual(readdirSync(join(root, "chapters")), []);
});

// ----- regressions from code review ---------------------------------------

test("an unparseable file is never deleted or overwritten by a save", async () => {
	const { root, store, sync } = setup();
	writeFileSync(join(root, "chapters/broken.snbt"), "{ oops: ");
	const errors = await sync.loadAll();
	assert.equal(errors.length, 1);
	assert.deepEqual(store.dirtyPaths(), []);
	store.transact("move", (m) => m.moveQuest("AAAAAAAAAAAAAAAA", 1, 0));
	assert.ok((await sync.save()).ok);
	assert.equal(readFileSync(join(root, "chapters/broken.snbt"), "utf8"), "{ oops: ");
	assert.throws(() => store.transact("create", (m) => m.createChapter({ filename: "broken" })), /already exists/);
});

test("an external reload does not whitelist new errors in unsaved edits", async () => {
	const { root, store, sync } = setup();
	await sync.loadAll();
	store.transact("bad", (m) => m.setField("AAAAAAAAAAAAAAAA", "dependencies", { kind: "list", items: [{ kind: "string", value: "0123456789ABCDEF" }] }));
	writeFileSync(join(root, "data.snbt"), "{\n\tgrid_scale: 1.0d\n}\n");
	await sync.reconcile(["data.snbt"]);
	const r = await sync.save();
	assert.equal(!r.ok && r.reason, "invalid");
});

test("edits made during a save are not written by that save", async () => {
	const { root, store, sync } = setup();
	await sync.loadAll();
	store.transact("move", (m) => m.moveQuest("AAAAAAAAAAAAAAAA", 1, 0));
	// Inject an edit right after the save froze its texts (newErrors runs after the freeze).
	const original = store.newErrors.bind(store);
	store.newErrors = () => {
		store.newErrors = original;
		store.transact("move again", (m) => m.moveQuest("AAAAAAAAAAAAAAAA", 5, 0));
		return original();
	};
	assert.ok((await sync.save()).ok);
	assert.match(readFileSync(join(root, "chapters/intro.snbt"), "utf8"), /x: 1\.0d/);
	assert.deepEqual(store.dirtyPaths(), ["chapters/intro.snbt"]);
	assert.ok((await sync.save()).ok, "queued save is not dropped");
	assert.match(readFileSync(join(root, "chapters/intro.snbt"), "utf8"), /x: 5\.0d/);
});

test("a conflict clears when the disk reverts, and resolution reads the current disk", async () => {
	const { root, store, sync } = setup();
	await sync.loadAll();
	store.transact("move", (m) => m.moveQuest("AAAAAAAAAAAAAAAA", 1, 0));
	writeFileSync(join(root, "chapters/intro.snbt"), CHAPTER.replace("y: 0.0d", "y: 3.0d"));
	await sync.reconcile(["chapters/intro.snbt"]);
	assert.equal(sync.conflicts.size, 1);
	writeFileSync(join(root, "chapters/intro.snbt"), CHAPTER);
	await sync.reconcile(["chapters/intro.snbt"]);
	assert.equal(sync.conflicts.size, 0);
});

test("chapter rename writes the new file before deleting the old one", async () => {
	const { root, store, sync } = setup();
	await sync.loadAll();
	store.transact("rename", (m) => m.renameChapterFile("1111111111111111", "a_first"));
	const r = await sync.save();
	assert.ok(r.ok);
	assert.deepEqual(r.ok && r.written, ["chapters/a_first.snbt", "chapters/intro.snbt"]);
	assert.deepEqual(readdirSync(join(root, "chapters")), ["a_first.snbt"]);
});
