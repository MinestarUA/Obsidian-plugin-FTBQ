/**
 * Create / read / update / delete / link / unlink operations on the quest graph.
 *
 * All operations go through a MutationContext so the store can snapshot every file a
 * transaction touches (undo/redo) and invalidate the id index afterwards. The mutator never
 * writes to disk.
 */

import {
	bool,
	cloneNode,
	compound,
	double,
	get,
	getList,
	getNumber,
	getString,
	int,
	list,
	long,
	remove,
	set,
	setNumber,
	str,
	stringItems,
	type CompoundNode,
	type ListNode,
	type SnbtNode,
} from "./snbtNodes";
import {
	chapterQuests,
	ID_RE,
	langKey,
	parseLangKey,
	rootCompound,
	type IdIndex,
	type IndexedObject,
	type ObjectKind,
	type QuestFile,
} from "./questModel";

export interface MutationContext {
	readonly files: Map<string, QuestFile>;
	/** Current id index (rebuilt lazily after `invalidate`). */
	index(): IdIndex;
	/** Must be called before a file is modified; records its pre-image for undo. */
	touch(path: string): void;
	createFile(path: string, root: CompoundNode): QuestFile;
	deleteFile(path: string): void;
	renameFile(from: string, to: string): void;
	invalidate(): void;
	/** Locale new text goes to, e.g. `uk_ua`. */
	readonly locale: string;
	/** `grid_scale` from data.snbt. */
	readonly gridScale: number;
}

export class GraphError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GraphError";
	}
}

export interface PlaceOptions {
	/** Round to multiples of data.snbt `grid_scale` (default true). */
	snap?: boolean;
	/** Move to the nearest free cell if another quest occupies the spot (default true). */
	avoidCollisions?: boolean;
}

export type LangValue = string | string[];

// ---------------------------------------------------------------------------
// Builders for common FTB objects (layouts match what FTB writes)
// ---------------------------------------------------------------------------

/** `{ count: 1, id: "minecraft:dirt" }` — task items are written on one line by FTB. */
export function itemStack(id: string, count = 1, inline = true): CompoundNode {
	return compound({ count: int(count), id: str(id) }, inline);
}

export function itemTask(itemId: string, count = 1): Record<string, SnbtNode> {
	const t: Record<string, SnbtNode> = { item: itemStack(itemId, 1), type: str("item") };
	if (count > 1) t.count = long(count);
	return t;
}

export function checkmarkTask(): Record<string, SnbtNode> {
	return { type: str("checkmark") };
}

/**
 * Reward items are written multi-line by FTB. The amount lives in the reward's own int
 * `count` (written only when > 1); the stack itself keeps count 1.
 */
export function itemReward(itemId: string, count = 1): Record<string, SnbtNode> {
	const r: Record<string, SnbtNode> = { item: itemStack(itemId, 1, false), type: str("item") };
	if (count > 1) r.count = int(count);
	return r;
}

export function xpReward(amount: number): Record<string, SnbtNode> {
	return { type: str("xp"), xp: int(amount) };
}

// ---------------------------------------------------------------------------

export class GraphMutator {
	constructor(private readonly ctx: MutationContext) {}

	// ----- ids -------------------------------------------------------------

	newId(reserved: Set<string> = new Set()): string {
		const index = this.ctx.index();
		for (;;) {
			const bytes = new Uint8Array(8);
			crypto.getRandomValues(bytes);
			const id = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
			if (id !== "0000000000000000" && !index.get(id) && !reserved.has(id)) return id;
		}
	}

	private require(id: string, kind?: ObjectKind): IndexedObject {
		const o = this.ctx.index().get(id);
		if (!o) throw new GraphError(`Unknown id ${id}`);
		if (kind && o.kind !== kind) throw new GraphError(`${id} is a ${o.kind}, expected ${kind}`);
		return o;
	}

	private file(path: string): QuestFile {
		const f = this.ctx.files.get(path);
		if (!f) throw new GraphError(`Unknown file ${path}`);
		return f;
	}

	private chapterFile(chapterId: string): QuestFile {
		return this.file(this.require(chapterId, "chapter").file);
	}

	/** Gets (creating if missing) a list entry of a compound. */
	private listOf(node: CompoundNode, key: string): ListNode {
		let l = getList(node, key);
		if (!l) {
			l = list();
			set(node, key, l);
		}
		return l;
	}

	// ----- generic field access ------------------------------------------

	/** Sets an arbitrary field of any object (e.g. `shape`, `size`, `optional`). */
	setField(id: string, key: string, value: SnbtNode): void {
		if (key === "id") throw new GraphError("Ids are immutable");
		const o = this.require(id);
		this.ctx.touch(o.file);
		set(o.node, key, value);
		this.ctx.invalidate();
	}

	removeField(id: string, key: string): void {
		if (key === "id") throw new GraphError("Ids are immutable");
		const o = this.require(id);
		this.ctx.touch(o.file);
		remove(o.node, key);
		this.ctx.invalidate();
	}

	// ----- lang ------------------------------------------------------------

	private langFiles(locale?: string): QuestFile[] {
		return [...this.ctx.files.values()].filter((f) => f.kind === "lang" && (locale === undefined || f.locale === locale));
	}

	getText(kind: ObjectKind, id: string, field: string, locale = this.ctx.locale): LangValue | undefined {
		const key = langKey(kind, id, field);
		for (const f of this.langFiles(locale)) {
			const v = get(rootCompound(f), key);
			if (v?.kind === "string") return v.value;
			if (v?.kind === "list") return stringItems(v);
		}
		return undefined;
	}

	/** Sets (or with `undefined`, removes) a lang entry such as a quest title or description. */
	setText(kind: ObjectKind, id: string, field: string, value: LangValue | undefined, locale = this.ctx.locale): void {
		const key = langKey(kind, id, field);
		const files = this.langFiles(locale);
		let target = files.find((f) => get(rootCompound(f), key));
		if (!target && value === undefined) return;
		if (!target) target = files.find((f) => f.path === `lang/${locale}.snbt`) ?? files[0];
		if (!target) target = this.ctx.createFile(`lang/${locale}.snbt`, compound());
		this.ctx.touch(target.path);
		const root = rootCompound(target);
		if (value === undefined) remove(root, key);
		else set(root, key, typeof value === "string" ? str(value) : list(value.map(str)));
	}

	/** Copies or removes all lang keys of an object, across every locale. */
	private forEachLangKey(id: string, fn: (file: QuestFile, root: CompoundNode, key: string, field: string) => void): void {
		for (const f of this.langFiles()) {
			const root = rootCompound(f);
			for (const e of [...root.entries]) {
				const k = parseLangKey(e.key);
				if (k && k.id.toUpperCase() === id) fn(f, root, e.key, k.field);
			}
		}
	}

	private removeLang(ids: Iterable<string>): void {
		for (const id of ids) {
			this.forEachLangKey(id, (f, root, key) => {
				this.ctx.touch(f.path);
				remove(root, key);
			});
		}
	}

	private copyLang(fromId: string, toId: string): void {
		this.forEachLangKey(fromId, (f, root, key) => {
			const p = parseLangKey(key)!;
			this.ctx.touch(f.path);
			set(root, `${p.prefix}.${toId}.${p.field}`, cloneNode(get(root, key)!));
		});
	}

	// ----- chapters --------------------------------------------------------

	createChapter(opts: { filename: string; title?: string; group?: string; icon?: string }): string {
		const filename = opts.filename.trim();
		if (!/^[a-z0-9_]+$/.test(filename)) throw new GraphError(`Invalid chapter filename "${filename}" (use a-z, 0-9, _)`);
		const path = `chapters/${filename}.snbt`;
		if (this.ctx.files.has(path)) throw new GraphError(`${path} already exists`);
		const index = this.ctx.index();
		if (opts.group) this.require(opts.group, "chapter_group");
		const order = Math.max(-1, ...index.ofKind("chapter").map((c) => getNumber(c.node, "order_index") ?? 0)) + 1;
		const id = this.newId();
		const fields: Record<string, SnbtNode> = {
			default_hide_dependency_lines: bool(false),
			default_quest_shape: str(""),
			filename: str(filename),
			group: str(opts.group ?? ""),
			id: str(id),
			order_index: int(order),
			quest_links: list(),
			quests: list(),
		};
		if (opts.icon) fields.icon = compound({ id: str(opts.icon) });
		this.ctx.createFile(path, compound(fields));
		this.ctx.invalidate();
		if (opts.title) this.setText("chapter", id, "title", opts.title);
		return id;
	}

	/** Renames a chapter's file (and its `filename` field, which FTB requires to match). */
	renameChapterFile(chapterId: string, filename: string): void {
		if (!/^[a-z0-9_]+$/.test(filename)) throw new GraphError(`Invalid chapter filename "${filename}"`);
		const f = this.chapterFile(chapterId);
		const to = `chapters/${filename}.snbt`;
		if (to === f.path) return;
		if (this.ctx.files.has(to)) throw new GraphError(`${to} already exists`);
		this.ctx.touch(f.path);
		set(rootCompound(f), "filename", str(filename));
		this.ctx.renameFile(f.path, to);
		this.ctx.invalidate();
	}

	/** Deletes a chapter file and scrubs every reference to its quests from the project. */
	deleteChapter(chapterId: string): void {
		const f = this.chapterFile(chapterId);
		const root = rootCompound(f);
		const removed = new Set<string>([chapterId]);
		for (const q of chapterQuests(root)) for (const id of this.subtreeIds(q)) removed.add(id);
		for (const l of getList(root, "quest_links")?.items ?? []) {
			const id = l.kind === "compound" ? getString(l, "id") : undefined;
			if (id) removed.add(id);
		}
		this.ctx.deleteFile(f.path);
		this.scrubReferences(removed);
		this.removeLang(removed);
		this.ctx.invalidate();
	}

	// ----- quests ----------------------------------------------------------

	createQuest(
		chapterId: string,
		opts: { x: number; y: number; title?: string; tasks?: Record<string, SnbtNode>[]; dependencies?: string[] } & PlaceOptions,
	): string {
		const f = this.chapterFile(chapterId);
		for (const d of opts.dependencies ?? []) this.require(d, "quest");
		const pos = this.place(chapterId, opts.x, opts.y, 1, undefined, opts);
		const id = this.newId();
		const reserved = new Set([id]);
		const tasks = (opts.tasks ?? [checkmarkTask()]).map((t) => {
			const tid = this.newId(reserved);
			reserved.add(tid);
			return compound({ ...t, id: str(tid) });
		});
		const fields: Record<string, SnbtNode> = { id: str(id), tasks: list(tasks), x: double(pos.x), y: double(pos.y) };
		if (opts.dependencies?.length) fields.dependencies = list(opts.dependencies.map(str));
		this.ctx.touch(f.path);
		this.listOf(rootCompound(f), "quests").items.push(compound(fields));
		this.ctx.invalidate();
		if (opts.title) this.setText("quest", id, "title", opts.title);
		return id;
	}

	/** Moves a quest within its chapter. Returns the final position. */
	moveQuest(questId: string, x: number, y: number, opts: PlaceOptions = {}): { x: number; y: number } {
		const q = this.require(questId, "quest");
		const pos = this.place(q.parent!, x, y, getNumber(q.node, "size") ?? 1, questId, opts);
		this.ctx.touch(q.file);
		setNumber(q.node, "x", pos.x);
		setNumber(q.node, "y", pos.y);
		this.ctx.invalidate();
		return pos;
	}

	/** Moves a quest to another chapter. Its id (and so player progress) is kept. */
	moveQuestToChapter(questId: string, chapterId: string, at?: { x: number; y: number }): void {
		const q = this.require(questId, "quest");
		if (q.parent === chapterId) return;
		const from = this.file(q.file);
		const to = this.chapterFile(chapterId);
		this.ctx.touch(from.path);
		this.ctx.touch(to.path);
		if (getString(rootCompound(from), "autofocus_id") === questId) remove(rootCompound(from), "autofocus_id");
		const fromList = getList(rootCompound(from), "quests")!;
		fromList.items.splice(fromList.items.indexOf(q.node), 1);
		const node = q.node; // same depth in the new file, so it can stay verbatim
		this.listOf(rootCompound(to), "quests").items.push(node);
		this.ctx.invalidate();
		this.moveQuest(questId, at?.x ?? getNumber(node, "x") ?? 0, at?.y ?? getNumber(node, "y") ?? 0);
	}

	/** Deletes a quest and removes every dependency / link / focus pointing at it. */
	deleteQuest(questId: string): void {
		const q = this.require(questId, "quest");
		const ids = this.subtreeIds(q.node);
		this.ctx.touch(q.file);
		const quests = getList(rootCompound(this.file(q.file)), "quests")!;
		quests.items.splice(quests.items.indexOf(q.node), 1);
		this.scrubReferences(ids);
		this.removeLang(ids);
		this.ctx.invalidate();
	}

	/**
	 * Duplicates a quest next to the original: fresh ids for the quest and all its tasks and
	 * rewards, lang text copied, same upstream dependencies. Downstream quests are not rewired.
	 */
	duplicateQuest(questId: string, offset = { x: 1, y: 0 }): string {
		const q = this.require(questId, "quest");
		const copy = cloneNode(q.node);
		const reserved = new Set<string>();
		const fresh = () => {
			const id = this.newId(reserved);
			reserved.add(id);
			return id;
		};
		const newId = fresh();
		set(copy, "id", str(newId));
		const remap: [string, string][] = [[questId, newId]];
		for (const key of ["tasks", "rewards"]) {
			for (const t of getList(copy, key)?.items ?? []) {
				if (t.kind !== "compound") continue;
				const old = getString(t, "id");
				const nid = fresh();
				set(t, "id", str(nid));
				if (old) remap.push([old, nid]);
			}
		}
		const f = this.file(q.file);
		this.ctx.touch(f.path);
		getList(rootCompound(f), "quests")!.items.push(copy);
		this.ctx.invalidate();
		for (const [from, to] of remap) this.copyLang(from, to);
		this.moveQuest(newId, (getNumber(q.node, "x") ?? 0) + offset.x, (getNumber(q.node, "y") ?? 0) + offset.y);
		return newId;
	}

	// ----- dependencies ----------------------------------------------------

	/** Makes `questId` depend on `dependencyId`. Rejects self-links and cycles. */
	addDependency(questId: string, dependencyId: string): void {
		const q = this.require(questId, "quest");
		this.require(dependencyId, "quest");
		if (questId === dependencyId) throw new GraphError("A quest cannot depend on itself");
		const deps = getList(q.node, "dependencies");
		if (stringItems(deps).includes(dependencyId)) return;
		const path = this.dependencyPath(dependencyId, questId);
		if (path) throw new GraphError(`Dependency would create a cycle: ${[questId, ...path].join(" → ")}`);
		this.ctx.touch(q.file);
		this.listOf(q.node, "dependencies").items.push(str(dependencyId));
		this.ctx.invalidate();
	}

	removeDependency(questId: string, dependencyId: string): void {
		const q = this.require(questId, "quest");
		const deps = getList(q.node, "dependencies");
		if (!deps) return;
		const i = deps.items.findIndex((d) => d.kind === "string" && d.value === dependencyId);
		if (i < 0) return;
		this.ctx.touch(q.file);
		deps.items.splice(i, 1);
		if (deps.items.length === 0) remove(q.node, "dependencies");
		this.ctx.invalidate();
	}

	/**
	 * Path of quest ids from `from` to `to` following `dependencies` edges, or undefined.
	 * Adding "to depends on from" is a cycle exactly when such a path exists.
	 */
	dependencyPath(from: string, to: string): string[] | undefined {
		const index = this.ctx.index();
		const prev = new Map<string, string | null>([[from, null]]);
		const queue = [from];
		while (queue.length) {
			const cur = queue.shift()!;
			if (cur === to) {
				const path: string[] = [];
				for (let c: string | null = cur; c !== null; c = prev.get(c)!) path.unshift(c);
				return path;
			}
			const node = index.get(cur)?.node;
			if (!node) continue;
			for (const d of stringItems(getList(node, "dependencies"))) {
				if (!prev.has(d)) {
					prev.set(d, cur);
					queue.push(d);
				}
			}
		}
		return undefined;
	}

	// ----- tasks & rewards -------------------------------------------------

	addTask(questId: string, fields: Record<string, SnbtNode>): string {
		return this.addChild(questId, "tasks", fields);
	}

	addReward(questId: string, fields: Record<string, SnbtNode>): string {
		return this.addChild(questId, "rewards", fields);
	}

	private addChild(questId: string, key: "tasks" | "rewards", fields: Record<string, SnbtNode>): string {
		const q = this.require(questId, "quest");
		const id = this.newId();
		this.ctx.touch(q.file);
		this.listOf(q.node, key).items.push(compound({ ...fields, id: str(id) }));
		this.ctx.invalidate();
		return id;
	}

	/** Removes a task or reward. A quest keeps at least one task, as FTB expects. */
	removeTaskOrReward(id: string): void {
		const o = this.require(id);
		if (o.kind !== "task" && o.kind !== "reward") throw new GraphError(`${id} is a ${o.kind}`);
		const q = this.require(o.parent!, "quest");
		const key = o.kind === "task" ? "tasks" : "rewards";
		const l = getList(q.node, key)!;
		if (o.kind === "task" && l.items.length <= 1) throw new GraphError("A quest needs at least one task");
		this.ctx.touch(q.file);
		l.items.splice(l.items.indexOf(o.node), 1);
		if (l.items.length === 0) remove(q.node, key);
		this.removeLang([id]);
		this.ctx.invalidate();
	}

	// ----- quest links -----------------------------------------------------

	/** Shows a quest from another chapter in `chapterId` (FTB "quest link"). */
	linkQuest(chapterId: string, questId: string, x: number, y: number): string {
		const f = this.chapterFile(chapterId);
		this.require(questId, "quest");
		const pos = this.place(chapterId, x, y, 1, undefined, {});
		const id = this.newId();
		this.ctx.touch(f.path);
		this.listOf(rootCompound(f), "quest_links").items.push(
			compound({ id: str(id), linked_quest: str(questId), x: double(pos.x), y: double(pos.y) }),
		);
		this.ctx.invalidate();
		return id;
	}

	unlinkQuest(linkId: string): void {
		const l = this.require(linkId, "quest_link");
		this.ctx.touch(l.file);
		const links = getList(rootCompound(this.file(l.file)), "quest_links")!;
		links.items.splice(links.items.indexOf(l.node), 1);
		this.removeLang([linkId]);
		this.ctx.invalidate();
	}

	// ----- spatial -----------------------------------------------------------

	snap(v: number): number {
		const g = this.ctx.gridScale;
		const r = Math.round(v / g) * g;
		return Number(r.toFixed(6)) + 0; // drop float noise (1.5000000000000002) and -0
	}

	/** Snaps and finds the nearest spot in the chapter not overlapping another quest. */
	place(chapterId: string, x: number, y: number, size: number, ignoreId: string | undefined, opts: PlaceOptions) {
		const snap = opts.snap ?? true;
		const sx = snap ? this.snap(x) : x;
		const sy = snap ? this.snap(y) : y;
		if (opts.avoidCollisions === false) return { x: sx, y: sy };
		const occupied = this.occupied(chapterId, ignoreId);
		const free = (px: number, py: number) => occupied.every((o) => Math.hypot(o.x - px, o.y - py) >= (o.size + size) / 2 - 1e-9);
		if (free(sx, sy)) return { x: sx, y: sy };
		const step = this.ctx.gridScale;
		for (let ring = 1; ring <= 200; ring++) {
			const candidates: { x: number; y: number }[] = [];
			for (let i = -ring; i <= ring; i++) {
				for (let j = -ring; j <= ring; j++) {
					if (Math.max(Math.abs(i), Math.abs(j)) !== ring) continue;
					candidates.push({ x: Number((sx + i * step).toFixed(6)) + 0, y: Number((sy + j * step).toFixed(6)) + 0 });
				}
			}
			candidates.sort((a, b) => Math.hypot(a.x - sx, a.y - sy) - Math.hypot(b.x - sx, b.y - sy));
			const hit = candidates.find((c) => free(c.x, c.y));
			if (hit) return hit;
		}
		return { x: sx, y: sy };
	}

	private occupied(chapterId: string, ignoreId?: string): { x: number; y: number; size: number }[] {
		const root = rootCompound(this.chapterFile(chapterId));
		const out: { x: number; y: number; size: number }[] = [];
		const nodes = [...chapterQuests(root), ...(getList(root, "quest_links")?.items ?? [])];
		for (const n of nodes) {
			if (n.kind !== "compound" || getString(n, "id") === ignoreId) continue;
			out.push({ x: getNumber(n, "x") ?? 0, y: getNumber(n, "y") ?? 0, size: getNumber(n, "size") ?? 1 });
		}
		return out;
	}

	// ----- reference scrubbing ------------------------------------------------

	/** Ids of a quest and its tasks and rewards. */
	private subtreeIds(quest: CompoundNode): Set<string> {
		const ids = new Set<string>();
		const qid = getString(quest, "id");
		if (qid) ids.add(qid);
		for (const key of ["tasks", "rewards"]) {
			for (const t of getList(quest, key)?.items ?? []) {
				const id = t.kind === "compound" ? getString(t, "id") : undefined;
				if (id) ids.add(id);
			}
		}
		return ids;
	}

	/** Removes dependencies, quest links and autofocus entries pointing at removed ids. */
	private scrubReferences(removed: Set<string>): void {
		for (const f of this.ctx.files.values()) {
			if (f.kind !== "chapter") continue;
			const root = rootCompound(f);
			if (removed.has(getString(root, "autofocus_id") ?? "")) {
				this.ctx.touch(f.path);
				remove(root, "autofocus_id");
			}
			const links = getList(root, "quest_links");
			if (links) {
				const keep = links.items.filter((l) => !(l.kind === "compound" && removed.has(getString(l, "linked_quest") ?? "")));
				if (keep.length !== links.items.length) {
					this.ctx.touch(f.path);
					for (const l of links.items) {
						const id = !keep.includes(l) && l.kind === "compound" ? getString(l, "id") : undefined;
						if (id) removed.add(id);
					}
					links.items = keep;
				}
			}
			for (const q of chapterQuests(root)) {
				const deps = getList(q, "dependencies");
				if (!deps) continue;
				const keep = deps.items.filter((d) => !(d.kind === "string" && removed.has(d.value)));
				if (keep.length === deps.items.length) continue;
				this.ctx.touch(f.path);
				if (keep.length) deps.items = keep;
				else remove(q, "dependencies");
			}
		}
	}

	// ----- chapter groups ------------------------------------------------------

	createChapterGroup(title?: string): string {
		let f = this.ctx.files.get("chapter_groups.snbt");
		if (!f) f = this.ctx.createFile("chapter_groups.snbt", compound({ chapter_groups: list() }));
		const id = this.newId();
		this.ctx.touch(f.path);
		this.listOf(rootCompound(f), "chapter_groups").items.push(compound({ id: str(id) }, true));
		this.ctx.invalidate();
		if (title) this.setText("chapter_group", id, "title", title);
		return id;
	}

	deleteChapterGroup(groupId: string): void {
		const g = this.require(groupId, "chapter_group");
		const f = this.file(g.file);
		this.ctx.touch(f.path);
		const l = getList(rootCompound(f), "chapter_groups")!;
		l.items.splice(l.items.indexOf(g.node), 1);
		for (const c of this.ctx.index().ofKind("chapter")) {
			if (getString(c.node, "group") !== groupId) continue;
			this.ctx.touch(c.file);
			set(c.node, "group", str(""));
		}
		this.removeLang([groupId]);
		this.ctx.invalidate();
	}

	moveChapterGroup(groupId: string, delta: number): void {
		const g = this.require(groupId, "chapter_group");
		this.ctx.touch(g.file);
		this.shift(getList(rootCompound(this.file(g.file)), "chapter_groups")!.items, g.node, delta);
		this.ctx.invalidate();
	}

	setChapterGroup(chapterId: string, groupId: string): void {
		if (groupId) this.require(groupId, "chapter_group");
		this.setField(chapterId, "group", str(groupId));
	}

	/** Moves a chapter up/down in the book by swapping `order_index` values (renumbering all). */
	moveChapter(chapterId: string, delta: number): void {
		const chapters = this.ctx
			.index()
			.ofKind("chapter")
			.sort((a, b) => (getNumber(a.node, "order_index") ?? 0) - (getNumber(b.node, "order_index") ?? 0));
		const nodes = chapters.map((c) => c.node);
		const me = this.require(chapterId, "chapter").node;
		this.shift(nodes, me, delta);
		nodes.forEach((n, i) => {
			if (getNumber(n, "order_index") === i) return;
			this.ctx.touch(chapters.find((c) => c.node === n)!.file);
			set(n, "order_index", int(i));
		});
		this.ctx.invalidate();
	}

	/** Moves a task or reward up/down within its quest. */
	moveChild(id: string, delta: number): void {
		const o = this.require(id);
		if (o.kind !== "task" && o.kind !== "reward") throw new GraphError(`${id} is a ${o.kind}`);
		const q = this.require(o.parent!, "quest");
		this.ctx.touch(q.file);
		this.shift(getList(q.node, o.kind === "task" ? "tasks" : "rewards")!.items, o.node, delta);
		this.ctx.invalidate();
	}

	private shift<T>(items: T[], item: T, delta: number): void {
		const i = items.indexOf(item);
		const j = Math.max(0, Math.min(items.length - 1, i + delta));
		if (i < 0 || i === j) return;
		items.splice(i, 1);
		items.splice(j, 0, item);
	}

	// ----- generic field edits on non-indexed compounds ------------------------

	/** Sets (value) or removes (undefined) a key of `node`, which lives in `path`. */
	private put(path: string, node: CompoundNode, key: string, value: SnbtNode | undefined): void {
		this.ctx.touch(path);
		if (value === undefined) remove(node, key);
		else set(node, key, value);
		this.ctx.invalidate();
	}

	/** Sets or (undefined) removes a field of any indexed object. */
	putField(id: string, key: string, value: SnbtNode | undefined): void {
		if (value === undefined) this.removeField(id, key);
		else this.setField(id, key, value);
	}

	// ----- chapter images -------------------------------------------------------

	private images(chapterId: string): { path: string; list: ListNode } {
		const f = this.chapterFile(chapterId);
		return { path: f.path, list: this.listOf(rootCompound(f), "images") };
	}

	private image(chapterId: string, index: number): { path: string; node: CompoundNode } {
		const { path, list: l } = this.images(chapterId);
		const n = l.items[index];
		if (n?.kind !== "compound") throw new GraphError(`No image #${index}`);
		return { path, node: n };
	}

	addImage(chapterId: string, image: string, x: number, y: number): number {
		const { path, list: l } = this.images(chapterId);
		this.ctx.touch(path);
		l.items.push(compound({ height: double(1), image: str(image), rotation: double(0), width: double(1), x: double(x), y: double(y) }));
		this.ctx.invalidate();
		return l.items.length - 1;
	}

	setImageField(chapterId: string, index: number, key: string, value: SnbtNode | undefined): void {
		const { path, node } = this.image(chapterId, index);
		this.put(path, node, key, value);
	}

	removeImage(chapterId: string, index: number): void {
		const { path, list: l } = this.images(chapterId);
		this.image(chapterId, index);
		this.ctx.touch(path);
		l.items.splice(index, 1);
		if (!l.items.length) remove(rootCompound(this.file(path)), "images");
		this.ctx.invalidate();
	}

	duplicateImage(chapterId: string, index: number): number {
		const { path, node } = this.image(chapterId, index);
		const copy = cloneNode(node);
		setNumber(copy, "x", (getNumber(node, "x") ?? 0) + 1, "d");
		const l = this.images(chapterId).list;
		this.ctx.touch(path);
		l.items.splice(index + 1, 0, copy);
		this.ctx.invalidate();
		return index + 1;
	}

	/** FTB "Paste Quest": copy of a quest (fresh ids) placed at x, y in `chapterId`. */
	copyQuest(questId: string, chapterId: string, x: number, y: number, withDeps: boolean): string {
		const id = this.duplicateQuest(questId, { x: 0, y: 0 });
		this.moveQuestToChapter(id, chapterId);
		if (!withDeps) this.removeField(id, "dependencies");
		this.moveQuest(id, x, y);
		return id;
	}

	/** FTB "Paste Image": copies image #index of one chapter to x, y in another. */
	copyImage(fromChapter: string, index: number, toChapter: string, x: number, y: number): number {
		const { node } = this.image(fromChapter, index);
		const copy = cloneNode(node);
		set(copy, "x", double(x));
		set(copy, "y", double(y));
		const { path, list: l } = this.images(toChapter);
		this.ctx.touch(path);
		l.items.push(copy);
		this.ctx.invalidate();
		return l.items.length - 1;
	}

	// ----- data.snbt --------------------------------------------------------------

	setFileField(key: string, value: SnbtNode | undefined): void {
		const f = this.ctx.files.get("data.snbt") ?? this.ctx.createFile("data.snbt", compound());
		this.put(f.path, rootCompound(f), key, value);
	}

	// ----- reward tables ------------------------------------------------------------

	createRewardTable(filename: string, title?: string): string {
		if (!/^[a-z0-9_]+$/.test(filename)) throw new GraphError(`Invalid reward table filename "${filename}" (use a-z, 0-9, _)`);
		const path = `reward_tables/${filename}.snbt`;
		if (this.ctx.files.has(path)) throw new GraphError(`${path} already exists`);
		const id = this.newId();
		this.ctx.createFile(path, compound({ id: str(id), loot_size: int(1), rewards: list() }));
		this.ctx.invalidate();
		if (title) this.setText("reward_table", id, "title", title);
		return id;
	}

	/** Deletes a reward table; rewards that pointed at it are left for the validator to flag. */
	deleteRewardTable(tableId: string): void {
		const t = this.require(tableId, "reward_table");
		this.ctx.deleteFile(t.file);
		this.removeLang([tableId]);
		this.ctx.invalidate();
	}

	private tableRewards(tableId: string): { path: string; list: ListNode } {
		const t = this.require(tableId, "reward_table");
		return { path: t.file, list: this.listOf(t.node, "rewards") };
	}

	addTableReward(tableId: string, fields: Record<string, SnbtNode>): number {
		const { path, list: l } = this.tableRewards(tableId);
		this.ctx.touch(path);
		const reserved = new Set<string>();
		for (const r of l.items) if (r.kind === "compound" && getString(r, "id")) reserved.add(getString(r, "id")!);
		l.items.push(compound({ ...fields, id: str(this.newId(reserved)) }));
		this.ctx.invalidate();
		return l.items.length - 1;
	}

	setTableRewardField(tableId: string, index: number, key: string, value: SnbtNode | undefined): void {
		const { path, list: l } = this.tableRewards(tableId);
		const n = l.items[index];
		if (n?.kind !== "compound") throw new GraphError(`No reward #${index}`);
		if (key === "id") throw new GraphError("Ids are immutable");
		this.put(path, n, key, value);
	}

	removeTableReward(tableId: string, index: number): void {
		const { path, list: l } = this.tableRewards(tableId);
		if (!l.items[index]) throw new GraphError(`No reward #${index}`);
		this.ctx.touch(path);
		l.items.splice(index, 1);
		this.ctx.invalidate();
	}

	static isValidId(id: string): boolean {
		return ID_RE.test(id) && id !== "0000000000000000";
	}
}
