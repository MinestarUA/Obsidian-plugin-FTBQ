import { getList, getNumber, getString, stringItems, type CompoundNode } from "./snbtNodes";
import { ID_RE, IdIndex, parseLangKey, rootCompound, type QuestFile } from "./questModel";

export type Severity = "error" | "warning";

export interface Issue {
	severity: Severity;
	code: string;
	message: string;
	file?: string;
	id?: string;
}

export function issueKey(i: Issue): string {
	return `${i.code}|${i.file ?? ""}|${i.id ?? ""}|${i.message}`;
}

/** Schema and referential-integrity checks over the whole quest directory. */
export function validateProject(files: Iterable<QuestFile>, index = new IdIndex(files)): Issue[] {
	const all = [...files];
	const issues: Issue[] = [];
	const err = (code: string, message: string, file?: string, id?: string) => issues.push({ severity: "error", code, message, file, id });
	const warn = (code: string, message: string, file?: string, id?: string) => issues.push({ severity: "warning", code, message, file, id });

	for (const f of all) {
		if (f.doc.root.kind !== "compound") err("root_not_compound", "Root value must be a compound", f.path);
	}

	for (const d of index.duplicates) {
		const first = index.get(d.id)!;
		err("duplicate_id", `Id ${d.id} is used by a ${first.kind} (${first.file}) and a ${d.kind} (${d.file})`, d.file, d.id);
	}
	for (const o of index.objects.values()) {
		if (!ID_RE.test(o.id) || o.id === "0000000000000000") err("bad_id", `${o.kind} id "${o.id}" is not 16 upper-case hex digits`, o.file, o.id);
	}

	for (const f of all) {
		if (f.kind !== "chapter" || f.doc.root.kind !== "compound") continue;
		const root = rootCompound(f);
		const chapterId = getString(root, "id");
		if (!chapterId) err("missing_id", "Chapter has no id", f.path);
		const filename = getString(root, "filename");
		const expected = f.path.replace(/^chapters\//, "").replace(/\.snbt$/, "");
		if (filename !== expected) err("filename_mismatch", `filename "${filename}" does not match file name "${expected}"`, f.path, chapterId);
		const group = getString(root, "group");
		if (group && index.get(group)?.kind !== "chapter_group") err("unknown_group", `Chapter group ${group} does not exist`, f.path, chapterId);
		const focus = getString(root, "autofocus_id");
		if (focus && !index.get(focus)) warn("unknown_autofocus", `autofocus_id ${focus} does not exist`, f.path, chapterId);

		for (const q of getList(root, "quests")?.items ?? []) {
			if (q.kind !== "compound") {
				err("bad_quest", "Quest entry is not a compound", f.path);
				continue;
			}
			checkQuest(q, f, index, err, warn);
		}
		for (const l of getList(root, "quest_links")?.items ?? []) {
			if (l.kind !== "compound") continue;
			const lid = getString(l, "id");
			const target = getString(l, "linked_quest");
			if (!target || index.get(target)?.kind !== "quest") err("dangling_link", `Quest link points at missing quest ${target}`, f.path, lid);
		}
	}

	for (const r of index.references) {
		if (r.field === "table_id" && !index.get(r.to)) warn("unknown_reward_table", `Reward table ${r.to} does not exist`, r.file, r.from);
	}

	for (const cycle of findCycles(index)) {
		err("dependency_cycle", `Dependency cycle: ${cycle.join(" → ")}`, index.get(cycle[0]!)?.file, cycle[0]);
	}

	for (const f of all) {
		if (f.kind !== "lang" || f.doc.root.kind !== "compound") continue;
		for (const e of rootCompound(f).entries) {
			const k = parseLangKey(e.key);
			if (k && !index.get(k.id.toUpperCase())) warn("orphan_lang", `Lang key ${e.key} belongs to no object`, f.path, k.id);
		}
	}
	return issues;
}

function checkQuest(
	q: CompoundNode,
	f: QuestFile,
	index: IdIndex,
	err: (c: string, m: string, f?: string, id?: string) => void,
	warn: (c: string, m: string, f?: string, id?: string) => void,
): void {
	const qid = getString(q, "id");
	if (!qid) err("missing_id", "Quest has no id", f.path);
	if (getNumber(q, "x") === undefined || getNumber(q, "y") === undefined) err("missing_position", "Quest has no numeric x/y", f.path, qid);
	const tasks = getList(q, "tasks")?.items ?? [];
	if (tasks.length === 0) warn("no_tasks", "Quest has no tasks", f.path, qid);
	for (const key of ["tasks", "rewards"]) {
		for (const t of getList(q, key)?.items ?? []) {
			if (t.kind !== "compound" || !getString(t, "id")) err("missing_id", `A ${key.slice(0, -1)} has no id`, f.path, qid);
			else if (!getString(t, "type")) err("missing_type", `${key.slice(0, -1)} ${getString(t, "id")} has no type`, f.path, qid);
		}
	}
	for (const d of stringItems(getList(q, "dependencies"))) {
		if (d === qid) err("self_dependency", "Quest depends on itself", f.path, qid);
		const target = index.get(d);
		if (!target) err("dangling_dependency", `Dependency ${d} does not exist`, f.path, qid);
		else if (target.kind !== "quest") err("bad_dependency", `Dependency ${d} is a ${target.kind}, not a quest`, f.path, qid);
	}
}

/** Returns one representative cycle per strongly connected component of the dependency graph. */
export function findCycles(index: IdIndex): string[][] {
	const quests = index.ofKind("quest");
	const deps = new Map(quests.map((q) => [q.id, stringItems(getList(q.node, "dependencies")).filter((d) => index.get(d)?.kind === "quest")]));
	const state = new Map<string, 1 | 2>(); // 1 = on stack, 2 = done
	const stack: string[] = [];
	const cycles: string[][] = [];
	const visit = (id: string) => {
		state.set(id, 1);
		stack.push(id);
		for (const d of deps.get(id) ?? []) {
			const s = state.get(d);
			if (s === 1) cycles.push([...stack.slice(stack.indexOf(d)), d]);
			else if (s === undefined) visit(d);
		}
		stack.pop();
		state.set(id, 2);
	};
	for (const q of quests) if (!state.has(q.id)) visit(q.id);
	return cycles;
}
