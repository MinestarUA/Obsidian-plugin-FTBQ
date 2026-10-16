import { t as tr } from "./i18n";
import { App, FileSystemAdapter, Modal, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { QuestStore } from "./state/store";
import { SyncEngine, type SaveResult } from "./sync/fileWatcher";
import { AssetLibrary } from "./ui/assets";
import { QuestGraphView, VIEW_TYPE } from "./ui/questView";
import type { Issue } from "./engine/validator";

interface Settings {
	/** Absolute path of the FTB Quests `quests` directory (or relative to the vault). */
	questsRoot: string;
	/** Locale new titles/descriptions are written to. */
	locale: string;
	/** Autosave delay after the last edit in ms; 0 = save only via command. */
	autosaveMs: number;
	backupKeep: number;
	/** Jar files or folders of jars to read item icons from (mods folder, Minecraft client jar). */
	assetSources: string[];
	/** Chapter shown when the graph view opens. */
	lastChapter?: string;
}

const DEFAULTS: Settings = { questsRoot: "config/ftbquests/quests", locale: "en_us", autosaveMs: 0, backupKeep: 20, assetSources: [] };

export default class FtbQuestsEditorPlugin extends Plugin {
	override settings: Settings = { ...DEFAULTS };
	store!: QuestStore;
	sync?: SyncEngine;
	assets?: AssetLibrary;
	private redrawTimer?: number;
	private status?: HTMLElement;
	private autosaveTimer?: number;

	/** Public API for views and other plugins. */
	get api() {
		return { store: this.store, sync: this.sync, save: () => this.save(), reload: () => this.reload() };
	}

	override async onload(): Promise<void> {
		this.settings = { ...DEFAULTS, ...((await this.loadData()) as Partial<Settings> | null) };
		this.addSettingTab(new SettingsTab(this.app, this));
		this.status = this.addStatusBarItem();
		this.store = this.createStore();
		this.resetAssets();

		this.registerView(VIEW_TYPE, (leaf) => new QuestGraphView(leaf, this));
		this.addRibbonIcon("git-fork", tr("FTB Quests: quest graph"), () => void this.openGraph());
		this.addCommand({ id: "open-graph", name: "Open quest graph editor", callback: () => void this.openGraph() });

		this.addCommand({ id: "reload", name: "Reload quests from disk", callback: () => this.confirmReload() });
		this.addCommand({ id: "save", name: "Save quests", callback: () => void this.save() });
		this.addCommand({
			id: "undo",
			name: "Undo last quest edit",
			checkCallback: (checking) => {
				if (!this.store?.canUndo()) return false;
				if (!checking) new Notice(`Undid: ${this.store.undo()?.label}`);
				return true;
			},
		});
		this.addCommand({
			id: "redo",
			name: "Redo quest edit",
			checkCallback: (checking) => {
				if (!this.store?.canRedo()) return false;
				if (!checking) new Notice(`Redid: ${this.store.redo()?.label}`);
				return true;
			},
		});
		this.addCommand({
			id: "validate",
			name: "Validate quests",
			callback: () => this.showValidation(),
		});
		this.addCommand({
			id: "resolve-conflicts",
			name: "Resolve quest file conflicts",
			checkCallback: (checking) => {
				if (!this.sync?.conflicts.size) return false;
				if (!checking) this.showConflicts();
				return true;
			},
		});

		this.app.workspace.onLayoutReady(() => void this.reload());
	}

	override onunload(): void {
		void this.sync?.dispose();
		if (this.autosaveTimer) window.clearTimeout(this.autosaveTimer);
		if (this.redrawTimer) window.clearTimeout(this.redrawTimer);
		this.assets?.dispose();
	}

	vaultPath(): string {
		const a = this.app.vault.adapter;
		if (!(a instanceof FileSystemAdapter)) throw new Error("FTB Quests Editor needs the desktop app");
		return a.getBasePath();
	}

	questsRoot(): string {
		const r = this.settings.questsRoot;
		const root = isAbsolute(r) ? r : join(this.vaultPath(), r);
		// A fresh clone of the quests vault has no data.json yet: fall back to its own copy.
		const vaultCopy = join(this.vaultPath(), "ftbquests", "quests");
		return !existsSync(root) && existsSync(vaultCopy) ? vaultCopy : root;
	}

	/** Reloads, asking first when there are unsaved edits (a reload discards them). */
	confirmReload(): void {
		const dirty = this.store?.dirtyPaths() ?? [];
		if (!dirty.length) {
			void this.reload();
			return;
		}
		new ConfirmModal(this.app, "Discard unsaved quest edits?", `Reloading discards unsaved changes in: ${dirty.join(", ")}`, () => void this.reload()).open();
	}

	async reload(): Promise<void> {
		await this.sync?.dispose();
		this.sync = undefined;
		const root = this.questsRoot();
		if (!existsSync(root)) {
			new Notice(`FTB Quests: folder not found: ${root}. Set it in the plugin settings.`);
			this.updateStatus();
			return;
		}
		const store = this.store;
		store.locale = this.settings.locale;
		this.sync = new SyncEngine(store, {
			root,
			backupDir: join(this.vaultPath(), this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`, "backups"),
			backupKeep: this.settings.backupKeep,
		});
		this.sync.on((e) => {
			if (e.type === "conflict") new Notice(`FTB Quests: ${e.conflict.path} changed on disk while you had unsaved edits. Run "Resolve quest file conflicts".`, 10000);
			if (e.type === "reloaded" && e.overwroteOurSave) {
				new Notice(`FTB Quests: ${e.path} was overwritten externally (Minecraft?). Your saved version is lost from disk; run /ftbquests reload in game after saving next time.`, 15000);
			}
			if (e.type === "error") console.error("[ftbquests-editor]", e.message, e.error);
			this.updateStatus();
		});
		const errors = await this.sync.loadAll();
		for (const { path, error } of errors) new Notice(`FTB Quests: cannot parse ${path}: ${error.message}`, 15000);
		this.sync.start();
		new Notice(`FTB Quests: loaded ${store.files.size} files, ${store.index().ofKind("quest").length} quests. Remember: edits made in game overwrite these files unless you run /ftbquests reload after saving.`, 8000);
		this.updateStatus();
	}

	async openGraph(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
		const leaf = existing ?? this.app.workspace.getLeaf("tab");
		if (!existing) await leaf.setViewState({ type: VIEW_TYPE, active: true });
		this.app.workspace.revealLeaf(leaf);
	}

	showValidation(): void {
		new IssuesModal(this.app, "Quest validation", this.store.validate()).open();
	}

	showConflicts(): void {
		new ConflictModal(this.app, this).open();
	}

	/** (Re)creates the icon library from the configured jar sources. */
	resetAssets(): void {
		const vault = this.vaultPath();
		const sources = this.settings.assetSources.map((s) => (isAbsolute(s) ? s : join(vault, s)));
		this.assets?.dispose();
		this.assets = new AssetLibrary(sources, () => {
			// Many icons arrive at once: redraw at most every 100 ms.
			if (this.redrawTimer) return;
			this.redrawTimer = window.setTimeout(() => {
				this.redrawTimer = undefined;
				for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) (leaf.view as QuestGraphView).redraw();
			}, 100);
		});
	}

	private createStore(): QuestStore {
		const store = new QuestStore({ locale: this.settings.locale });
		store.subscribe((e) => {
			this.updateStatus();
			if (e.source !== "disk" && e.source !== "load" && this.settings.autosaveMs > 0) {
				if (this.autosaveTimer) window.clearTimeout(this.autosaveTimer);
				this.autosaveTimer = window.setTimeout(() => void this.save(true), this.settings.autosaveMs);
			}
		});
		return store;
	}

	async save(quiet = false): Promise<SaveResult | undefined> {
		if (!this.sync) return undefined;
		const r = await this.sync.save();
		if (r.ok) {
			if (!quiet || r.written.length) new Notice(r.written.length ? `FTB Quests: saved ${r.written.length} file(s)` : "FTB Quests: nothing to save");
		} else if (r.reason === "conflicts") new ConflictModal(this.app, this).open();
		else if (r.reason === "invalid") new IssuesModal(this.app, "Save blocked: new errors", r.issues).open();
		else if (r.reason === "roundtrip") new Notice(`FTB Quests: save blocked, ${r.path} failed the round-trip check: ${r.message}`, 15000);
		else new Notice(`FTB Quests: writing ${r.failed} failed (${String(r.error)}). Already written: ${r.written.join(", ") || "none"}`, 15000);
		this.updateStatus();
		return r;
	}

	updateStatus(): void {
		if (!this.status) return;
		if (!this.sync) {
			this.status.setText("FTBQ: not loaded");
			return;
		}
		const dirty = this.store.dirtyPaths().length;
		const conflicts = this.sync.conflicts.size;
		this.status.setText(`FTBQ: ${dirty ? `${dirty} unsaved` : "saved"}${conflicts ? ` · ${conflicts} conflict(s)` : ""}`);
	}
}

class IssuesModal extends Modal {
	constructor(
		app: App,
		private readonly heading: string,
		private readonly issues: Issue[],
	) {
		super(app);
	}

	override onOpen(): void {
		this.titleEl.setText(this.heading);
		const errors = this.issues.filter((i) => i.severity === "error").length;
		this.contentEl.createEl("p", { text: `${errors} error(s), ${this.issues.length - errors} warning(s)` });
		const ul = this.contentEl.createEl("ul");
		for (const i of this.issues.slice(0, 500)) {
			ul.createEl("li", { text: `${i.severity === "error" ? "❌" : "⚠️"} [${i.code}] ${i.message}${i.file ? ` — ${i.file}` : ""}` });
		}
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}

class ConflictModal extends Modal {
	constructor(
		app: App,
		private readonly plugin: FtbQuestsEditorPlugin,
	) {
		super(app);
	}

	override onOpen(): void {
		this.titleEl.setText("Quest files changed on disk");
		this.render();
	}

	private async resolve(path: string, choice: "mine" | "theirs"): Promise<void> {
		try {
			await this.plugin.sync?.resolveConflict(path, choice);
		} catch (e) {
			new Notice(`FTB Quests: the disk version of ${path} cannot be parsed (${(e as Error).message}). Fix it on disk or keep yours.`, 15000);
		}
		this.plugin.updateStatus();
		this.render();
	}

	private render(): void {
		this.contentEl.empty();
		const sync = this.plugin.sync;
		if (!sync?.conflicts.size) {
			this.contentEl.createEl("p", { text: "No conflicts." });
			return;
		}
		this.contentEl.createEl("p", { text: "These files changed outside Obsidian while you had unsaved edits. Saving is blocked until each is resolved." });
		for (const c of sync.conflicts.values()) {
			new Setting(this.contentEl)
				.setName(c.path)
				.setDesc(c.disk === null ? "Deleted on disk" : "Modified on disk")
				.addButton((b) =>
					b.setButtonText("Keep mine").setWarning().onClick(() => void this.resolve(c.path, "mine")),
				)
				.addButton((b) =>
					b.setButtonText("Take disk version").onClick(() => void this.resolve(c.path, "theirs")),
				);
		}
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}

class ConfirmModal extends Modal {
	constructor(
		app: App,
		private readonly heading: string,
		private readonly text: string,
		private readonly onConfirm: () => void,
	) {
		super(app);
	}

	override onOpen(): void {
		this.titleEl.setText(this.heading);
		this.contentEl.createEl("p", { text: this.text });
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) =>
				b.setButtonText("Discard and reload").setWarning().onClick(() => {
					this.close();
					this.onConfirm();
				}),
			);
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}

class SettingsTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: FtbQuestsEditorPlugin,
	) {
		super(app, plugin);
	}

	override display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const save = async () => this.plugin.saveData(this.plugin.settings);
		new Setting(containerEl)
			.setName("Quests folder")
			.setDesc("The FTB Quests `quests` directory (absolute, or relative to the vault). Reload after changing.")
			.addText((t) =>
				t.setValue(this.plugin.settings.questsRoot).onChange(async (v) => {
					this.plugin.settings.questsRoot = v.trim();
					await save();
				}),
			);
		new Setting(containerEl)
			.setName("Text locale")
			.setDesc("Lang file new titles and descriptions are written to, e.g. uk_ua or en_us.")
			.addText((t) =>
				t.setValue(this.plugin.settings.locale).onChange(async (v) => {
					this.plugin.settings.locale = v.trim() || "en_us";
					if (this.plugin.store) this.plugin.store.locale = this.plugin.settings.locale;
					await save();
				}),
			);
		new Setting(containerEl)
			.setName("Autosave delay (ms)")
			.setDesc("0 = save only with the “Save quests” command.")
			.addText((t) =>
				t.setValue(String(this.plugin.settings.autosaveMs)).onChange(async (v) => {
					const n = Number(v);
					if (Number.isFinite(n) && n >= 0) this.plugin.settings.autosaveMs = n;
					await save();
				}),
			);
		new Setting(containerEl)
			.setName("Backups to keep")
			.setDesc("Previous file versions are copied to the plugin's backups/ folder before every save.")
			.addText((t) =>
				t.setValue(String(this.plugin.settings.backupKeep)).onChange(async (v) => {
					const n = Number(v);
					if (Number.isInteger(n) && n >= 1) this.plugin.settings.backupKeep = n;
					await save();
				}),
			);
		new Setting(containerEl)
			.setName("Icon sources")
			.setDesc("One per line: mods folder and/or Minecraft client jar (e.g. from Prism libraries/com/mojang/minecraft/1.21.1/). Item textures are read from these jars.")
			.addTextArea((t) => {
				t.inputEl.rows = 3;
				t.inputEl.style.width = "100%";
				t.setValue(this.plugin.settings.assetSources.join("\n"));
				// Re-index only when editing is finished, not on every keystroke.
				t.inputEl.addEventListener("change", async () => {
					this.plugin.settings.assetSources = t.getValue().split("\n").map((l) => l.trim()).filter(Boolean);
					this.plugin.resetAssets();
					await save();
				});
			});
		new Setting(containerEl).addButton((b) => b.setButtonText("Reload now").onClick(() => this.plugin.confirmReload()));
	}
}
