/**
 * Project state: every quest file in memory, transactional mutations and undo/redo.
 *
 * Undo works on text snapshots: a transaction records the serialized text of each file it
 * touches before and after the change. Undo re-parses the "before" text, which restores the
 * file byte-for-byte (including layout), so undo can never corrupt formatting.
 */

import { GraphMutator, type MutationContext } from "../engine/graphMutator";
import { classifyPath, gridScale, IdIndex, type QuestFile } from "../engine/questModel";
import { parseSnbt } from "../engine/snbtParser";
import { serialize } from "../engine/snbtSerializer";
import type { CompoundNode } from "../engine/snbtNodes";
import { issueKey, validateProject, type Issue } from "../engine/validator";

export interface FileSnapshot {
	path: string;
	/** null = the file did not exist. */
	before: string | null;
	after: string | null;
}

export interface Transaction {
	label: string;
	at: number;
	files: FileSnapshot[];
}

export type ChangeSource = "edit" | "undo" | "redo" | "disk" | "load";

export interface StoreEvent {
	source: ChangeSource;
	label: string;
	paths: string[];
}

export interface StoreOptions {
	locale?: string;
	historyLimit?: number;
}

export class QuestStore {
	readonly files = new Map<string, QuestFile>();
	locale: string;
	private readonly historyLimit: number;
	private undoStack: Transaction[] = [];
	private redoStack: Transaction[] = [];
	/** Current serialized text per file (kept in sync after every change). */
	private readonly text = new Map<string, string>();
	/** Text last read from / written to disk; null = known not to exist on disk. */
	private readonly disk = new Map<string, string | null>();
	/** Files on disk that failed to parse: never written, deleted or overwritten. */
	readonly broken = new Map<string, Error>();
	private cachedIndex?: IdIndex;
	private baselineIssues = new Set<string>();
	private readonly listeners = new Set<(e: StoreEvent) => void>();
	private inTransaction = false;

	constructor(opts: StoreOptions = {}) {
		this.locale = opts.locale ?? "en_us";
		this.historyLimit = opts.historyLimit ?? 200;
	}

	// ----- loading ---------------------------------------------------------

	/**
	 * Replaces the whole project with the given file texts (path → text). Parse errors are
	 * collected, not thrown, so one broken file does not block the rest of the project.
	 */
	load(texts: Map<string, string>): { path: string; error: Error }[] {
		const errors: { path: string; error: Error }[] = [];
		this.files.clear();
		this.text.clear();
		this.disk.clear();
		this.broken.clear();
		for (const [path, src] of texts) {
			try {
				this.setFile(path, src);
				this.disk.set(path, src);
			} catch (e) {
				this.broken.set(path, e as Error);
				errors.push({ path, error: e as Error });
			}
		}
		this.undoStack = [];
		this.redoStack = [];
		this.invalidate();
		this.baselineIssues = new Set(this.validate().map(issueKey));
		this.emit({ source: "load", label: "Load", paths: [...texts.keys()] });
		return errors;
	}

	private setFile(path: string, src: string | null): void {
		if (src === null) {
			this.files.delete(path);
			this.text.delete(path);
			return;
		}
		const { kind, locale } = classifyPath(path);
		this.files.set(path, { path, kind, locale, doc: parseSnbt(src, path) });
		this.text.set(path, src);
	}

	// ----- reading ---------------------------------------------------------

	index(): IdIndex {
		return (this.cachedIndex ??= new IdIndex(this.files.values()));
	}

	invalidate(): void {
		this.cachedIndex = undefined;
	}

	get gridScale(): number {
		return gridScale(this.files.get("data.snbt"));
	}

	/** Read-only helper bound to the current state (e.g. `reader().getText(...)`). */
	reader(): GraphMutator {
		return new GraphMutator(this.context(() => {
			throw new Error("Use store.transact() to modify quests");
		}));
	}

	textOf(path: string): string | undefined {
		return this.text.get(path);
	}

	diskTextOf(path: string): string | null | undefined {
		return this.disk.get(path);
	}

	/** Files whose in-memory text differs from disk (including created and deleted files). */
	dirtyPaths(): string[] {
		const paths = new Set([...this.text.keys(), ...this.disk.keys()]);
		return [...paths].filter((p) => (this.text.get(p) ?? null) !== (this.disk.get(p) ?? null)).sort();
	}

	isDirty(path: string): boolean {
		return (this.text.get(path) ?? null) !== (this.disk.get(path) ?? null);
	}

	validate(): Issue[] {
		return validateProject(this.files.values(), this.index());
	}

	/** Errors that were not already present when the project was loaded. */
	newErrors(): Issue[] {
		return this.validate().filter((i) => i.severity === "error" && !this.baselineIssues.has(issueKey(i)));
	}

	// ----- mutation --------------------------------------------------------

	/**
	 * Runs `fn` as one undoable step. If `fn` throws, every touched file is restored and the
	 * error is rethrown.
	 */
	transact<T>(label: string, fn: (m: GraphMutator) => T): T {
		if (this.inTransaction) throw new Error("Nested transactions are not supported");
		this.inTransaction = true;
		const before = new Map<string, string | null>();
		const touch = (path: string) => {
			if (!before.has(path)) before.set(path, this.text.has(path) ? this.serializeCurrent(path) : null);
		};
		try {
			const result = fn(new GraphMutator(this.context(touch)));
			const snapshots: FileSnapshot[] = [];
			for (const [path, b] of before) {
				const after = this.files.has(path) ? this.serializeCurrent(path) : null;
				if (after !== null) this.reparse(path, after);
				else this.text.delete(path);
				if (after !== b) snapshots.push({ path, before: b, after });
			}
			this.invalidate();
			if (snapshots.length) {
				this.undoStack.push({ label, at: Date.now(), files: snapshots });
				if (this.undoStack.length > this.historyLimit) this.undoStack.shift();
				this.redoStack = [];
				this.emit({ source: "edit", label, paths: snapshots.map((s) => s.path) });
			}
			return result;
		} catch (e) {
			for (const [path, b] of before) this.setFile(path, b);
			this.invalidate();
			throw e;
		} finally {
			this.inTransaction = false;
		}
	}

	canUndo(): boolean {
		return this.undoStack.length > 0;
	}

	canRedo(): boolean {
		return this.redoStack.length > 0;
	}

	undo(): Transaction | undefined {
		const t = this.undoStack.pop();
		if (!t) return undefined;
		for (const s of t.files) this.setFile(s.path, s.before);
		this.redoStack.push(t);
		this.invalidate();
		this.emit({ source: "undo", label: t.label, paths: t.files.map((s) => s.path) });
		return t;
	}

	redo(): Transaction | undefined {
		const t = this.redoStack.pop();
		if (!t) return undefined;
		for (const s of t.files) this.setFile(s.path, s.after);
		this.undoStack.push(t);
		this.invalidate();
		this.emit({ source: "redo", label: t.label, paths: t.files.map((s) => s.path) });
		return t;
	}

	history(): readonly Transaction[] {
		return this.undoStack;
	}

	// ----- disk sync hooks (used by the sync engine) -----------------------

	/** Records that `text` is now what is on disk for `path` (after a save). */
	markSynced(path: string, text: string | null): void {
		this.disk.set(path, text);
	}

	/**
	 * Applies an external change to a file that has no unsaved edits. Undo history that
	 * touches the file is dropped, since its snapshots no longer match the file.
	 */
	applyDiskChange(path: string, text: string | null): void {
		this.setFile(path, text);
		this.disk.set(path, text);
		this.broken.delete(path);
		this.dropHistoryFor([path]);
		this.invalidate();
		// Problems that arrived with the external file are accepted; problems in our own
		// unsaved edits elsewhere must still block saving.
		for (const i of this.validate()) if (i.file === path) this.baselineIssues.add(issueKey(i));
		this.emit({ source: "disk", label: `Reloaded ${path}`, paths: [path] });
	}

	/** Discards in-memory edits of a file in favour of a given text (conflict: "take theirs"). */
	discardLocal(path: string, text: string | null): void {
		this.applyDiskChange(path, text);
	}

	private dropHistoryFor(paths: string[]): void {
		const hit = (t: Transaction) => t.files.some((s) => paths.includes(s.path));
		this.undoStack = this.undoStack.filter((t) => !hit(t));
		this.redoStack = this.redoStack.filter((t) => !hit(t));
	}

	// ----- events ----------------------------------------------------------

	subscribe(fn: (e: StoreEvent) => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	private emit(e: StoreEvent): void {
		for (const l of this.listeners) {
			try {
				l(e);
			} catch (err) {
				console.error("[ftbquests-editor] listener failed", err);
			}
		}
	}

	// ----- internals -------------------------------------------------------

	private serializeCurrent(path: string): string {
		return serialize(this.files.get(path)!.doc);
	}

	/**
	 * Re-parses a file from its new text so origins describe the current text again. This
	 * keeps later edits minimal and makes each transaction start from a pristine tree.
	 */
	private reparse(path: string, text: string): void {
		const { kind, locale } = classifyPath(path);
		this.files.set(path, { path, kind, locale, doc: parseSnbt(text, path) });
		this.text.set(path, text);
	}

	private context(touch: (path: string) => void): MutationContext {
		const store = this;
		return {
			files: this.files,
			index: () => this.index(),
			touch,
			invalidate: () => this.invalidate(),
			get locale() {
				return store.locale;
			},
			get gridScale() {
				return store.gridScale;
			},
			createFile: (path: string, root: CompoundNode) => {
				if (this.files.has(path) || this.broken.has(path)) throw new Error(`${path} already exists`);
				touch(path);
				const { kind, locale } = classifyPath(path);
				const file: QuestFile = { path, kind, locale, doc: { source: "", leading: "", root, trailing: "\n" } };
				this.files.set(path, file);
				return file;
			},
			deleteFile: (path: string) => {
				touch(path);
				this.files.delete(path);
			},
			renameFile: (from: string, to: string) => {
				if (this.files.has(to) || this.broken.has(to)) throw new Error(`${to} already exists`);
				touch(from);
				touch(to);
				const f = this.files.get(from)!;
				this.files.delete(from);
				const { kind, locale } = classifyPath(to);
				this.files.set(to, { ...f, path: to, kind, locale });
			},
		};
	}
}
