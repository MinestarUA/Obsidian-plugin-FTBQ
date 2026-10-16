/**
 * Disk ⇄ memory synchronisation for the quests directory.
 *
 * Rules:
 *  - Never overwrite a file whose disk content changed since we last read/wrote it
 *    (optimistic concurrency). Such files become conflicts and block every save until resolved,
 *    because one quest edit usually spans a chapter file and a lang file.
 *  - Writes are atomic: temp file in the same directory (name NOT ending in .snbt, so FTB never
 *    loads it as a chapter) → fsync → rename.
 *  - The previous disk version of every file is copied to a backup folder before it is replaced.
 *  - External changes to files without unsaved edits are reloaded silently; our own writes are
 *    recognised and ignored.
 *  - Events are debounced so a git checkout or `/ftbquests reload` causes one reconcile pass.
 */

import { watch, type FSWatcher } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { parseSnbt } from "../engine/snbtParser";
import { serialize } from "../engine/snbtSerializer";
import type { Issue } from "../engine/validator";
import type { QuestStore } from "../state/store";

export interface SyncOptions {
	/** Absolute path of the `ftbquests/quests` directory. */
	root: string;
	/** Absolute path where pre-save backups go (outside the quests dir and the git repo). */
	backupDir: string;
	backupKeep?: number;
	debounceMs?: number;
	/** Fallback polling interval in ms (0 disables). Catches events fs.watch misses. */
	pollMs?: number;
}

export interface Conflict {
	path: string;
	/** Current disk text (null = deleted on disk). */
	disk: string | null;
	detectedAt: number;
}

export type SyncEvent =
	| { type: "reloaded"; path: string; overwroteOurSave: boolean }
	| { type: "conflict"; conflict: Conflict }
	| { type: "saved"; paths: string[]; backup?: string }
	| { type: "error"; message: string; error?: unknown };

export type SaveResult =
	| { ok: true; written: string[]; backup?: string }
	| { ok: false; reason: "conflicts"; conflicts: Conflict[] }
	| { ok: false; reason: "invalid"; issues: Issue[] }
	| { ok: false; reason: "roundtrip"; path: string; message: string }
	| { ok: false; reason: "io"; written: string[]; failed: string; error: unknown };

export class SyncEngine {
	readonly conflicts = new Map<string, Conflict>();
	private readonly opts: Required<SyncOptions>;
	private watchers: FSWatcher[] = [];
	private pollTimer?: ReturnType<typeof setInterval>;
	private debounceTimer?: ReturnType<typeof setTimeout>;
	private readonly pending = new Set<string>();
	/** Texts we wrote ourselves, to ignore their watcher echo. */
	private readonly ourWrites = new Map<string, string | null>();
	/** Last text this session saved per path, to detect Minecraft overwriting it. */
	private readonly lastSaved = new Map<string, string | null>();
	private readonly mtimes = new Map<string, number>();
	private readonly listeners = new Set<(e: SyncEvent) => void>();
	private saving = false;
	private saveQueue: Promise<unknown> = Promise.resolve();
	private reconciling: Promise<void> = Promise.resolve();

	constructor(
		private readonly store: QuestStore,
		opts: SyncOptions,
	) {
		this.opts = { backupKeep: 20, debounceMs: 300, pollMs: 5000, ...opts };
	}

	// ----- loading ---------------------------------------------------------

	async loadAll(): Promise<{ path: string; error: Error }[]> {
		const texts = new Map<string, string>();
		for (const rel of await this.scan()) {
			const abs = this.abs(rel);
			texts.set(rel, await readFile(abs, "utf8"));
			this.mtimes.set(rel, (await stat(abs)).mtimeMs);
		}
		this.conflicts.clear();
		return this.store.load(texts);
	}

	/** All `*.snbt` files under the root as POSIX relative paths (dotfiles skipped). */
	async scan(): Promise<string[]> {
		const out: string[] = [];
		const walk = async (dir: string) => {
			let entries;
			try {
				entries = await readdir(dir, { withFileTypes: true });
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
				throw e;
			}
			for (const e of entries) {
				if (e.name.startsWith(".")) continue;
				const p = join(dir, e.name);
				if (e.isDirectory()) await walk(p);
				else if (e.isFile() && e.name.endsWith(".snbt")) out.push(this.rel(p));
			}
		};
		await walk(this.opts.root);
		return out.sort();
	}

	// ----- watching --------------------------------------------------------

	start(): void {
		this.stop();
		try {
			this.addWatcher(watch(this.opts.root, { recursive: true }, (_e, name) => this.onFsEvent(name)));
		} catch {
			// Recursive watching unsupported: watch the known directories individually.
			for (const d of ["", "chapters", "lang", "reward_tables"]) {
				try {
					const dir = join(this.opts.root, d);
					this.addWatcher(watch(dir, (_e, name) => this.onFsEvent(name ? join(d, name.toString()) : null)));
				} catch {
					/* directory may not exist */
				}
			}
		}
		if (this.opts.pollMs > 0) this.pollTimer = setInterval(() => void this.poll(), this.opts.pollMs);
	}

	private addWatcher(w: FSWatcher): void {
		// Without a listener, a removed directory or inotify exhaustion would be an uncaught error.
		w.on("error", (error) => this.emit({ type: "error", message: "File watcher failed; falling back to polling", error }));
		this.watchers.push(w);
	}

	stop(): void {
		for (const w of this.watchers) w.close();
		this.watchers = [];
		if (this.pollTimer) clearInterval(this.pollTimer);
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		this.pollTimer = this.debounceTimer = undefined;
	}

	private onFsEvent(name: string | Buffer | null): void {
		if (name === null) {
			void this.poll();
			return;
		}
		const rel = name.toString().split(sep).join("/");
		if (!rel.endsWith(".snbt") || basename(rel).startsWith(".")) return;
		this.queue(rel);
	}

	private queue(rel: string): void {
		this.pending.add(rel);
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		this.debounceTimer = setTimeout(() => {
			const paths = [...this.pending];
			this.pending.clear();
			this.reconciling = this.reconciling.then(() => this.reconcile(paths)).catch((error) => this.emit({ type: "error", message: "Reconcile failed", error }));
		}, this.opts.debounceMs);
	}

	/** Compares mtimes of all files (catches missed watcher events and new/deleted files). */
	private async poll(): Promise<void> {
		if (this.saving) return;
		try {
			const onDisk = new Set(await this.scan());
			const known = new Set([...this.store.files.keys(), ...this.mtimes.keys()]);
			for (const rel of new Set([...onDisk, ...known])) {
				if (!onDisk.has(rel)) {
					if (this.mtimes.has(rel) || this.store.diskTextOf(rel) != null) this.queue(rel);
					continue;
				}
				const m = (await stat(this.abs(rel))).mtimeMs;
				if (this.mtimes.get(rel) !== m) this.queue(rel);
			}
		} catch (error) {
			this.emit({ type: "error", message: "Polling the quests folder failed", error });
		}
	}

	/** Brings memory in line with disk for the given paths. */
	async reconcile(paths: string[]): Promise<void> {
		for (const rel of paths) {
			const disk = await this.readOrNull(rel);
			await this.refreshMtime(rel);
			if (this.ourWrites.has(rel) && this.ourWrites.get(rel) === disk) {
				this.ourWrites.delete(rel);
				continue;
			}
			if (disk === (this.store.diskTextOf(rel) ?? null)) {
				// Disk went back to what we know: any earlier conflict is gone.
				this.conflicts.delete(rel);
				continue;
			}
			if (!this.store.isDirty(rel)) {
				const overwroteOurSave = this.lastSaved.has(rel) && this.lastSaved.get(rel) !== disk;
				this.conflicts.delete(rel);
				try {
					this.store.applyDiskChange(rel, disk);
				} catch (error) {
					this.emit({ type: "error", message: `${rel} changed on disk but cannot be parsed`, error });
					if (!this.store.files.has(rel)) {
						// Never loaded (or already broken): nothing of ours to protect, just track it.
						this.store.broken.set(rel, error as Error);
						continue;
					}
					// Unparseable external edit of a loaded file: keep our state, surface it as a conflict.
					this.addConflict(rel, disk);
					continue;
				}
				this.emit({ type: "reloaded", path: rel, overwroteOurSave });
			} else {
				this.addConflict(rel, disk);
			}
		}
	}

	private addConflict(path: string, disk: string | null): void {
		const conflict = { path, disk, detectedAt: Date.now() };
		this.conflicts.set(path, conflict);
		this.emit({ type: "conflict", conflict });
	}

	/**
	 * Resolves a conflict against the disk content as it is *now*. "theirs" discards in-memory
	 * edits of the file; "mine" keeps them and accepts the disk text as the new base, so the
	 * next save overwrites it. Throws (leaving the conflict open) if "theirs" cannot be parsed.
	 */
	async resolveConflict(path: string, choice: "mine" | "theirs"): Promise<void> {
		if (!this.conflicts.has(path)) return;
		const disk = await this.readOrNull(path);
		if (choice === "theirs") this.store.discardLocal(path, disk);
		else this.store.markSynced(path, disk);
		this.conflicts.delete(path);
	}

	// ----- saving ------------------------------------------------------------

	/** Saves all dirty files. Concurrent calls are queued, never dropped. */
	save(): Promise<SaveResult> {
		const run = this.saveQueue.then(() => this.saveNow());
		this.saveQueue = run.catch(() => undefined);
		return run;
	}

	/** Stops watching and waits for in-flight saves and reconciles to finish. */
	async dispose(): Promise<void> {
		this.stop();
		await this.saveQueue;
		await this.reconciling.catch(() => undefined);
	}

	private async saveNow(): Promise<SaveResult> {
		this.saving = true;
		try {
			await this.reconciling;
			if (this.conflicts.size) return { ok: false, reason: "conflicts", conflicts: [...this.conflicts.values()] };
			const dirty = this.store.dirtyPaths();
			if (!dirty.length) return { ok: true, written: [] };

			// Freeze what will be written: edits made while saving wait for the next save.
			const texts = new Map(dirty.map((p) => [p, this.store.textOf(p) ?? null]));

			const issues = this.store.newErrors();
			if (issues.length) return { ok: false, reason: "invalid", issues };

			// Round-trip gate: what we write must parse back to exactly the same text.
			for (const [p, text] of texts) {
				if (text === null) continue;
				try {
					if (serialize(parseSnbt(text, p)) !== text) return { ok: false, reason: "roundtrip", path: p, message: "Re-serialization differs" };
				} catch (e) {
					return { ok: false, reason: "roundtrip", path: p, message: (e as Error).message };
				}
			}

			// Optimistic concurrency: every dirty file must still be what we last saw on disk.
			const current = new Map<string, string | null>();
			for (const p of dirty) {
				const disk = await this.readOrNull(p);
				current.set(p, disk);
				if (disk !== (this.store.diskTextOf(p) ?? null)) this.addConflict(p, disk);
			}
			if (this.conflicts.size) return { ok: false, reason: "conflicts", conflicts: [...this.conflicts.values()] };

			const backup = await this.backup(current);
			const written: string[] = [];
			// Writes before deletions, so a rename never leaves the chapter missing on disk.
			const order = [...dirty.filter((p) => texts.get(p) !== null), ...dirty.filter((p) => texts.get(p) === null)];
			for (const p of order) {
				const text = texts.get(p)!;
				try {
					// Last-moment re-check: something (Minecraft) may have written since the check above.
					const disk = await this.readOrNull(p);
					if (this.conflicts.has(p) || disk !== current.get(p)) {
						if (!this.conflicts.has(p)) this.addConflict(p, disk);
						return { ok: false, reason: "conflicts", conflicts: [...this.conflicts.values()] };
					}
					this.ourWrites.set(p, text);
					if (text === null) await unlink(this.abs(p)).catch((e) => (e.code === "ENOENT" ? undefined : Promise.reject(e)));
					else await atomicWrite(this.abs(p), text);
					this.store.markSynced(p, text);
					this.lastSaved.set(p, text);
					await this.refreshMtime(p);
					written.push(p);
				} catch (error) {
					this.ourWrites.delete(p);
					return { ok: false, reason: "io", written, failed: p, error };
				}
			}
			this.emit({ type: "saved", paths: written, backup });
			return { ok: true, written, backup };
		} finally {
			this.saving = false;
		}
	}

	/** Copies the current disk versions to `<backupDir>/<timestamp>/` and prunes old backups. */
	private async backup(current: Map<string, string | null>): Promise<string | undefined> {
		const existing = [...current].filter((e): e is [string, string] => e[1] !== null);
		if (!existing.length) return undefined;
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const dir = join(this.opts.backupDir, stamp);
		for (const [rel, text] of existing) await atomicWrite(join(dir, ...rel.split("/")), text);
		try {
			const all = (await readdir(this.opts.backupDir)).sort();
			for (const old of all.slice(0, Math.max(0, all.length - this.opts.backupKeep))) {
				await rm(join(this.opts.backupDir, old), { recursive: true, force: true });
			}
		} catch {
			/* pruning is best-effort */
		}
		return dir;
	}

	// ----- events / helpers ------------------------------------------------

	on(fn: (e: SyncEvent) => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	private emit(e: SyncEvent): void {
		for (const l of this.listeners) l(e);
	}

	private abs(rel: string): string {
		return join(this.opts.root, ...rel.split("/"));
	}

	private rel(abs: string): string {
		return relative(this.opts.root, abs).split(sep).join("/");
	}

	private async readOrNull(rel: string): Promise<string | null> {
		try {
			return await readFile(this.abs(rel), "utf8");
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw e;
		}
	}

	private async refreshMtime(rel: string): Promise<void> {
		try {
			this.mtimes.set(rel, (await stat(this.abs(rel))).mtimeMs);
		} catch {
			this.mtimes.delete(rel);
		}
	}
}

/** Write to a temp file in the same directory, fsync, then rename over the target. */
export async function atomicWrite(file: string, text: string): Promise<void> {
	const dir = dirname(file);
	await mkdir(dir, { recursive: true });
	const tmp = join(dir, `.${basename(file)}.${process.pid}.${Date.now().toString(36)}.tmp`);
	const fh = await open(tmp, "w");
	try {
		await fh.writeFile(text, "utf8");
		await fh.sync();
	} finally {
		await fh.close();
	}
	try {
		await rename(tmp, file);
	} catch (e) {
		await unlink(tmp).catch(() => undefined);
		throw e;
	}
	try {
		const d = await open(dir, "r");
		await d.sync().catch(() => undefined);
		await d.close();
	} catch {
		/* directory fsync is not supported everywhere (e.g. Windows) */
	}
}
