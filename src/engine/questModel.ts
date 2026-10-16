/**
 * Typed view over an FTB Quests directory (`config/ftbquests/quests/`):
 *
 *   data.snbt                 global settings (grid_scale, ...)
 *   chapter_groups.snbt       { chapter_groups: [{ id }] }
 *   chapters/<filename>.snbt  one chapter per file; `filename` must match the file name
 *   reward_tables/*.snbt      reward tables
 *   lang/<locale>.snbt        flat { "quest.<ID>.title": "..." } map
 *   lang/<locale>/*.snbt      (newer FTB builds may split lang per chapter — unverified, read if present)
 *
 * Every object (chapter, group, quest, task, reward, quest link, reward table) has a
 * 16-hex-digit id that is unique across the whole directory. Quest progress in world saves is
 * keyed by these ids, so an existing id must never change.
 */

import {
	getList,
	getString,
	stringItems,
	type CompoundNode,
	type SnbtDocument,
	type SnbtNode,
} from "./snbtNodes";

export type FileKind = "data" | "chapter_groups" | "chapter" | "reward_table" | "lang" | "other";

export interface QuestFile {
	/** POSIX path relative to the quests root, e.g. `chapters/malum.snbt`. */
	path: string;
	kind: FileKind;
	doc: SnbtDocument;
	/** Lang files only. */
	locale?: string;
}

export type ObjectKind = "chapter" | "chapter_group" | "quest" | "task" | "reward" | "quest_link" | "reward_table";

export interface IndexedObject {
	id: string;
	kind: ObjectKind;
	file: string;
	node: CompoundNode;
	/** For tasks/rewards: the owning quest id. For quests/quest links: the chapter id. */
	parent?: string;
}

/** A reference from one object to another id. */
export interface Reference {
	from: string;
	to: string;
	field: "dependencies" | "linked_quest" | "group" | "autofocus_id" | "table_id";
	file: string;
}

export const ID_RE = /^[0-9A-F]{16}$/;

/** Lang field names FTB uses per object kind. */
export const LANG_PREFIX: Record<ObjectKind, string> = {
	chapter: "chapter",
	chapter_group: "chapter_group",
	quest: "quest",
	task: "task",
	reward: "reward",
	quest_link: "quest_link",
	reward_table: "reward_table",
};

export function classifyPath(path: string): { kind: FileKind; locale?: string } {
	if (path === "data.snbt") return { kind: "data" };
	if (path === "chapter_groups.snbt") return { kind: "chapter_groups" };
	if (/^chapters\/[^/]+\.snbt$/.test(path)) return { kind: "chapter" };
	if (/^reward_tables\/[^/]+\.snbt$/.test(path)) return { kind: "reward_table" };
	let m = /^lang\/([^/]+)\.snbt$/.exec(path);
	if (m) return { kind: "lang", locale: m[1] };
	m = /^lang\/([^/]+)\/[^/]+\.snbt$/.exec(path);
	if (m) return { kind: "lang", locale: m[1] };
	return { kind: "other" };
}

export function rootCompound(file: QuestFile): CompoundNode {
	const r = file.doc.root;
	if (r.kind !== "compound") throw new Error(`${file.path}: root is not a compound`);
	return r;
}

/** Normalizes a reference value that may be stored as a hex string or a long. */
export function idOf(node: SnbtNode | undefined): string | undefined {
	if (!node) return undefined;
	if (node.kind === "string") return node.value;
	if (node.kind === "number" && (node.type === "l" || node.type === "i")) {
		return BigInt.asUintN(64, BigInt(node.text)).toString(16).toUpperCase().padStart(16, "0");
	}
	return undefined;
}

/**
 * Global id index with reverse references. Rebuilt from scratch after every transaction;
 * this is cheap (a few thousand nodes) and avoids incremental-update bugs.
 */
export class IdIndex {
	readonly objects = new Map<string, IndexedObject>();
	readonly duplicates: IndexedObject[] = [];
	readonly references: Reference[] = [];
	private readonly incoming = new Map<string, Reference[]>();

	constructor(files: Iterable<QuestFile>) {
		for (const f of files) this.indexFile(f);
		for (const r of this.references) {
			let l = this.incoming.get(r.to);
			if (!l) this.incoming.set(r.to, (l = []));
			l.push(r);
		}
	}

	get(id: string): IndexedObject | undefined {
		return this.objects.get(id);
	}

	referencesTo(id: string): readonly Reference[] {
		return this.incoming.get(id) ?? [];
	}

	ofKind(kind: ObjectKind): IndexedObject[] {
		return [...this.objects.values()].filter((o) => o.kind === kind);
	}

	private add(obj: Omit<IndexedObject, "id">, id: string | undefined): void {
		if (!id) return;
		const full = { ...obj, id };
		if (this.objects.has(id)) this.duplicates.push(full);
		else this.objects.set(id, full);
	}

	private indexFile(f: QuestFile): void {
		if (f.doc.root.kind !== "compound") return;
		const root = f.doc.root;
		switch (f.kind) {
			case "chapter_groups":
				for (const g of getList(root, "chapter_groups")?.items ?? []) {
					if (g.kind === "compound") this.add({ kind: "chapter_group", file: f.path, node: g }, getString(g, "id"));
				}
				break;
			case "reward_table":
				this.add({ kind: "reward_table", file: f.path, node: root }, getString(root, "id"));
				break;
			case "chapter": {
				const chapterId = getString(root, "id");
				this.add({ kind: "chapter", file: f.path, node: root }, chapterId);
				const group = getString(root, "group");
				if (chapterId && group) this.references.push({ from: chapterId, to: group, field: "group", file: f.path });
				const autofocus = getString(root, "autofocus_id");
				if (chapterId && autofocus) this.references.push({ from: chapterId, to: autofocus, field: "autofocus_id", file: f.path });
				for (const q of getList(root, "quests")?.items ?? []) {
					if (q.kind !== "compound") continue;
					const qid = getString(q, "id");
					this.add({ kind: "quest", file: f.path, node: q, parent: chapterId }, qid);
					if (!qid) continue;
					for (const dep of stringItems(getList(q, "dependencies"))) {
						this.references.push({ from: qid, to: dep, field: "dependencies", file: f.path });
					}
					for (const t of getList(q, "tasks")?.items ?? []) {
						if (t.kind === "compound") this.add({ kind: "task", file: f.path, node: t, parent: qid }, getString(t, "id"));
					}
					for (const r of getList(q, "rewards")?.items ?? []) {
						if (r.kind !== "compound") continue;
						const rid = getString(r, "id");
						this.add({ kind: "reward", file: f.path, node: r, parent: qid }, rid);
						const table = idOf(r.entries.find((e) => e.key === "table_id")?.value);
						if (rid && table) this.references.push({ from: rid, to: table, field: "table_id", file: f.path });
					}
				}
				for (const l of getList(root, "quest_links")?.items ?? []) {
					if (l.kind !== "compound") continue;
					const lid = getString(l, "id");
					this.add({ kind: "quest_link", file: f.path, node: l, parent: chapterId }, lid);
					const target = getString(l, "linked_quest");
					if (lid && target) this.references.push({ from: lid, to: target, field: "linked_quest", file: f.path });
				}
				break;
			}
		}
	}
}

/** Lang key of an object field, e.g. `quest.0123456789ABCDEF.title`. */
export function langKey(kind: ObjectKind, id: string, field: string): string {
	return `${LANG_PREFIX[kind]}.${id}.${field}`;
}

/** Parses a lang key into its parts; undefined for keys not tied to an object id. */
export function parseLangKey(key: string): { prefix: string; id: string; field: string } | undefined {
	const m = /^([a-z_]+)\.([0-9A-Fa-f]{16})\.(.+)$/.exec(key);
	return m ? { prefix: m[1]!, id: m[2]!, field: m[3]! } : undefined;
}

export function chapterQuests(chapter: CompoundNode): CompoundNode[] {
	return (getList(chapter, "quests")?.items ?? []).filter((q): q is CompoundNode => q.kind === "compound");
}

export function gridScale(dataFile: QuestFile | undefined): number {
	if (!dataFile || dataFile.doc.root.kind !== "compound") return 0.5;
	const v = dataFile.doc.root.entries.find((e) => e.key === "grid_scale")?.value;
	return v?.kind === "number" && Number(v.text) > 0 ? Number(v.text) : 0.5;
}
