import { FuzzySuggestModal, ItemView, Menu, Modal, Notice, Setting, type App, type WorkspaceLeaf } from "obsidian";
import type FtbQuestsEditorPlugin from "../main";
import { GraphError, itemReward, itemTask, type GraphMutator } from "../engine/graphMutator";
import { chapterQuests, idOf, type IndexedObject } from "../engine/questModel";
import { bool, cloneNode, compound, double, int, get, getBool, getCompound, getList, getNumber, getString, str, stringItems, type CompoundNode, type SnbtNode } from "../engine/snbtNodes";
import {
	CHAPTER_FIELDS,
	defaultFields,
	FILE_FIELDS,
	IMAGE_FIELDS,
	LANG_FIELDS,
	QUEST_FIELDS,
	REWARD_COMMON,
	REWARD_TABLE_FIELDS,
	REWARD_TYPES,
	rewardType,
	TASK_COMMON,
	TASK_TYPES,
	taskType,
} from "../engine/schema";
import { renderFields, type FieldHost } from "./fields";
import { GraphCanvas, imageId, type GEdge, type GImage, type GNode, type GraphData } from "./graphCanvas";

export const VIEW_TYPE = "ftbquests-graph";

const SHAPES = ["", "circle", "square", "rsquare", "diamond", "pentagon", "hexagon", "octagon", "heart", "gear", "none"];
const TASK_COLORS: Record<string, string> = {
	item: "#4f9dde",
	checkmark: "#3fb950",
	kill: "#e5534b",
	observation: "#a371f7",
	structure: "#d29922",
	biome: "#2da44e",
	dimension: "#db61a2",
	advancement: "#e3b341",
	xp: "#56d4dd",
};

/** Strips Minecraft `&x` / `§x` formatting codes. */
export function plain(text: string): string {
	return text.replace(/[&§][0-9a-fk-or]/gi, "").trim();
}

function shortItem(id: string): string {
	return (id.split(":")[1] ?? id).replace(/_/g, " ");
}

export class QuestGraphView extends ItemView {
	private canvas?: GraphCanvas;
	private chapterId?: string;
	private selection: string[] = [];
	private selectedEdge?: GEdge;
	private sidebarEl!: HTMLElement;
	private inspectorEl!: HTMLElement;
	private toolbarEl!: HTMLElement;
	private unsubscribe?: () => void;
	private chapterFilter = "";
	private showChapters = true;
	private refreshFrame = 0;
	private pendingRefresh = false;
	private pointerInInspector = false;
	/** What the inspector currently shows; it is rebuilt whenever this changes. */
	private inspectorKey = "";
	private showInspector = true;
	/** Collapsible sections the user opened / closed, kept across inspector rebuilds. */
	private readonly openSections = new Set<string>();
	private readonly closedSections = new Set<string>();

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: FtbQuestsEditorPlugin,
	) {
		super(leaf);
	}

	override getViewType(): string {
		return VIEW_TYPE;
	}

	override getDisplayText(): string {
		return "FTB Quests";
	}

	override getIcon(): string {
		return "git-fork";
	}

	private get store() {
		return this.plugin.store;
	}

	get storeRef() {
		return this.plugin.store;
	}

	get pluginRef() {
		return this.plugin;
	}

	editPublic<T>(label: string, fn: (m: GraphMutator) => T): T | undefined {
		return this.edit(label, fn);
	}

	override async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("ftbq-view");
		this.sidebarEl = root.createDiv("ftbq-sidebar");
		const main = root.createDiv("ftbq-main");
		this.toolbarEl = main.createDiv("ftbq-toolbar");
		const host = main.createDiv("ftbq-canvas-host");
		this.inspectorEl = root.createDiv("ftbq-inspector");
		// Narrow panes start with the side panels folded so the graph gets the space.
		const w = root.getBoundingClientRect().width;
		this.showChapters = w === 0 || w >= 1100;
		this.showInspector = w === 0 || w >= 800;
		this.applyPanels();

		this.canvas = new GraphCanvas(host, {
			gridScale: () => this.store.gridScale,
			onSelect: (ids) => {
				if (ids.length && !this.showInspector) {
					this.showInspector = true;
					this.applyPanels();
				}
				this.selection = ids;
				this.selectedEdge = undefined;
				this.renderInspector();
			},
			onEdgeSelect: (edge) => {
				this.selectedEdge = edge;
				this.renderInspector();
			},
			onMove: (moves, snap) => this.moveNodes(moves, snap),
			onConnect: (from, to) => this.connect(from, to),
			onCreate: (x, y) => this.createQuestAt(x, y),
			onContextMenu: (evt, t) => void this.contextMenu(evt, t),
			onCopy: (id) => this.copyObject(id),
			icon: (ref) => this.plugin.assets?.get(ref),
		});
		this.canvas.canvas.addEventListener("keydown", (e) => {
			this.canvas?.trackKey(e, true);
			this.onKey(e);
		});
		this.canvas.canvas.addEventListener("keyup", (e) => this.canvas?.trackKey(e, false));

		// Store events can arrive mid-transaction or mid-click: refresh on the next frame instead.
		this.unsubscribe = this.store.subscribe(() => this.scheduleRefresh());
		this.inspectorEl.addEventListener("pointerdown", () => (this.pointerInInspector = true));
		this.registerDomEvent(window, "pointerup", () => {
			if (!this.pointerInInspector) return;
			this.pointerInInspector = false;
			if (this.pendingRefresh) this.scheduleRefresh();
		});
		this.registerEvent(this.app.workspace.on("css-change", () => this.canvas?.request()));
		this.refresh();
	}

	override async onClose(): Promise<void> {
		this.unsubscribe?.();
		cancelAnimationFrame(this.refreshFrame);
		this.canvas?.destroy();
	}

	/** Called by the plugin when icons finish loading. */
	redraw(): void {
		this.canvas?.request();
	}

	// ----- data ------------------------------------------------------------

	private chapters(): IndexedObject[] {
		return this.store
			.index()
			.ofKind("chapter")
			.sort((a, b) => (getNumber(a.node, "order_index") ?? 0) - (getNumber(b.node, "order_index") ?? 0));
	}

	private text(kind: Parameters<GraphMutator["getText"]>[0], id: string, field: string): string {
		const v = this.store.reader().getText(kind, id, field);
		return Array.isArray(v) ? v.join("\n") : (v ?? "");
	}

	questLabel(q: CompoundNode): string {
		const id = getString(q, "id") ?? "";
		const title = plain(this.text("quest", id, "title"));
		if (title) return title;
		const t = getList(q, "tasks")?.items[0];
		if (t?.kind === "compound") {
			const item = getCompound(t, "item");
			const itemId = item ? getString(item, "id") : undefined;
			if (itemId) return shortItem(itemId);
			const type = getString(t, "type") ?? "";
			const target = getString(t, "entity") ?? getString(t, "structure") ?? getString(t, "biome") ?? getString(t, "dimension") ?? getString(t, "to_observe");
			return target ? `${type}: ${shortItem(target)}` : type;
		}
		return id;
	}

	private iconRef(q: CompoundNode): string | undefined {
		const fromStack = (stack: CompoundNode | undefined): string | undefined => {
			if (!stack) return undefined;
			const id = getString(stack, "id");
			if (id === "ftbquests:custom_icon") {
				const tex = getString(getCompound(stack, "components") ?? stack, "ftbquests:icon");
				return tex ? `tex:${tex}` : undefined;
			}
			if (id === "ftbfiltersystem:smart_filter") {
				const f = getString(getCompound(stack, "components") ?? stack, "ftbfiltersystem:filter") ?? "";
				return /item\(([^)]+)\)/.exec(f)?.[1];
			}
			return id;
		};
		const icon = get(q, "icon");
		if (icon?.kind === "string") return icon.value;
		if (icon?.kind === "compound") return fromStack(icon);
		for (const t of getList(q, "tasks")?.items ?? []) {
			if (t.kind !== "compound") continue;
			const ti = get(t, "icon");
			if (ti?.kind === "compound") return fromStack(ti);
			const r = fromStack(getCompound(t, "item"));
			if (r) return r;
		}
		return undefined;
	}

	private buildData(): GraphData {
		const nodes: GNode[] = [];
		const edges: GEdge[] = [];
		const images: GImage[] = [];
		const index = this.store.index();
		const chapter = this.chapterId ? index.get(this.chapterId) : undefined;
		if (!chapter) return { nodes, edges, images };
		const root = chapter.node;
		const defaultShape = getString(root, "default_quest_shape") || "circle";
		const errorIds = new Set(this.store.validate().filter((i) => i.severity === "error" && i.id).map((i) => i.id!));
		const visible = new Map<string, string>(); // quest id → node id shown in this chapter

		for (const q of chapterQuests(root)) {
			const id = getString(q, "id");
			if (!id) continue;
			const firstTask = getList(q, "tasks")?.items[0];
			const type = firstTask?.kind === "compound" ? (getString(firstTask, "type") ?? "") : "";
			nodes.push({
				id,
				kind: "quest",
				x: getNumber(q, "x") ?? 0,
				y: getNumber(q, "y") ?? 0,
				size: getNumber(q, "size") || getNumber(root, "default_quest_size") || 1,
				shape: getString(q, "shape") || defaultShape,
				label: this.questLabel(q),
				color: TASK_COLORS[type] ?? "#8b949e",
				optional: getBool(q, "optional") ?? false,
				invisible: getBool(q, "invisible") ?? false,
				hasError: errorIds.has(id),
				iconItem: this.iconRef(q),
				externalDeps: 0,
			});
			visible.set(id, id);
		}
		for (const l of getList(root, "quest_links")?.items ?? []) {
			if (l.kind !== "compound") continue;
			const id = getString(l, "id");
			const target = getString(l, "linked_quest");
			if (!id || !target) continue;
			const tq = index.get(target);
			nodes.push({
				id,
				kind: "link",
				target,
				x: getNumber(l, "x") ?? 0,
				y: getNumber(l, "y") ?? 0,
				size: getNumber(l, "size") ?? getNumber(tq?.node ?? l, "size") ?? 1,
				shape: getString(l, "shape") || (tq ? getString(tq.node, "shape") : undefined) || defaultShape,
				label: tq ? this.questLabel(tq.node) : `⚠ ${target}`,
				color: "#8b949e",
				optional: false,
				invisible: false,
				hasError: !tq,
				iconItem: tq ? this.iconRef(tq.node) : undefined,
				externalDeps: 0,
			});
			if (!visible.has(target)) visible.set(target, id);
		}
		const byId = new Map(nodes.map((n) => [n.id, n]));
		for (const q of chapterQuests(root)) {
			const id = getString(q, "id");
			if (!id) continue;
			const hidden = getBool(q, "hide_dependency_lines") ?? getBool(root, "default_hide_dependency_lines") ?? false;
			for (const dep of stringItems(getList(q, "dependencies"))) {
				const from = visible.get(dep);
				if (from) edges.push({ from, to: id, questId: id, depId: dep, hidden });
				else byId.get(id)!.externalDeps++;
			}
		}
		(getList(root, "images")?.items ?? []).forEach((img, index) => {
			if (img.kind !== "compound") return;
			const src = getString(img, "image") ?? "";
			images.push({
				index,
				locked: getBool(img, "position_locked") ?? false,
				x: getNumber(img, "x") ?? 0,
				y: getNumber(img, "y") ?? 0,
				w: getNumber(img, "width") ?? 1,
				h: getNumber(img, "height") ?? 1,
				rotation: getNumber(img, "rotation") ?? 0,
				label: src.split("/").pop() ?? src,
				src: src.endsWith(".png") ? src : undefined,
			});
		});
		return { nodes, edges, images };
	}

	// ----- rendering -------------------------------------------------------

	private scheduleRefresh(): void {
		this.pendingRefresh = true;
		// Rebuilding the inspector under a pressed button would swallow its click.
		if (this.pointerInInspector || this.refreshFrame) return;
		this.refreshFrame = requestAnimationFrame(() => {
			this.refreshFrame = 0;
			if (this.pointerInInspector) return;
			this.refresh();
		});
	}

	refresh(): void {
		this.pendingRefresh = false;
		if (!this.canvas) return;
		const chapters = this.chapters();
		if (!this.chapterId || !this.store.index().get(this.chapterId)) {
			const remembered = this.plugin.settings.lastChapter;
			this.chapterId = chapters.find((c) => c.id === remembered)?.id ?? chapters[0]?.id;
		}
		this.renderSidebar(chapters);
		this.renderToolbar();
		this.canvas.setData(this.buildData());
		this.selection = [...this.canvas.selection];
		this.selectedEdge = this.canvas.selectedEdge;
		// Keep a field the user is typing in, unless the inspector now shows something else.
		if (this.currentInspectorKey() !== this.inspectorKey || !this.inspectorEl.contains(document.activeElement)) this.renderInspector();
	}

	private renderSidebar(chapters: IndexedObject[]): void {
		const el = this.sidebarEl;
		el.empty();
		const head = el.createDiv("ftbq-sidebar-head");
		head.createSpan({ text: "Глави" });
		const add = head.createEl("button", { text: "+", attr: { "aria-label": "Нова глава" } });
		add.onclick = () => new ChapterModal(this.app, (filename, title) => this.edit("Нова глава", (m) => (this.chapterId = m.createChapter({ filename, title })))).open();
		const filter = el.createEl("input", { type: "search", placeholder: "Пошук…", cls: "ftbq-filter" });
		filter.value = this.chapterFilter;
		filter.oninput = () => {
			this.chapterFilter = filter.value;
			this.renderSidebar(this.chapters());
			const f = this.sidebarEl.querySelector<HTMLInputElement>(".ftbq-filter");
			f?.focus();
			f?.setSelectionRange(f.value.length, f.value.length);
		};
		const groups = new Map<string, IndexedObject[]>([["", []]]);
		for (const g of this.store.index().ofKind("chapter_group")) groups.set(g.id, []);
		for (const c of chapters) {
			const g = getString(c.node, "group") ?? "";
			if (!groups.has(g)) groups.set(g, []);
			groups.get(g)!.push(c);
		}
		const dirty = new Set(this.store.dirtyPaths());
		for (const [g, list] of groups) {
			if (g) {
				const gTitle = plain(this.text("chapter_group", g, "title")) || g;
				const row = el.createDiv({ cls: "ftbq-group", text: gTitle });
				row.oncontextmenu = (e) => {
					const menu = new Menu();
					menu.addItem((i) =>
						i.setTitle("Перейменувати групу…").setIcon("pencil").onClick(() =>
							new TextPrompt(this.app, "Назва групи", this.text("chapter_group", g, "title"), (v) => this.edit("Назва групи", (m) => m.setText("chapter_group", g, "title", v))).open(),
						),
					);
					menu.addItem((i) => i.setTitle("Вище").setIcon("arrow-up").onClick(() => this.edit("Порядок груп", (m) => m.moveChapterGroup(g, -1))));
					menu.addItem((i) => i.setTitle("Нижче").setIcon("arrow-down").onClick(() => this.edit("Порядок груп", (m) => m.moveChapterGroup(g, 1))));
					menu.addItem((i) =>
						i.setTitle("Видалити групу (глави лишаються)").setIcon("trash").onClick(() =>
							new ConfirmModal(this.app, `Видалити групу «${gTitle}»?`, () => this.edit("Видалити групу", (m) => m.deleteChapterGroup(g))).open(),
						),
					);
					menu.showAtMouseEvent(e);
				};
			} else if (!list.length) continue;
			for (const c of list) {
				const title = plain(this.text("chapter", c.id, "title")) || getString(c.node, "filename") || c.id;
				if (this.chapterFilter && !title.toLowerCase().includes(this.chapterFilter.toLowerCase())) continue;
				const row = el.createDiv({ cls: "ftbq-chapter" + (c.id === this.chapterId ? " is-active" : "") });
				row.createSpan({ cls: "ftbq-chapter-title", text: title });
				row.createSpan({ cls: "ftbq-chapter-count", text: `${chapterQuests(c.node).length}${dirty.has(c.file) ? " •" : ""}` });
				row.onclick = () => this.openChapter(c.id);
				row.oncontextmenu = (e) => {
					const menu = new Menu();
					menu.addItem((i) => i.setTitle("Вище").setIcon("arrow-up").onClick(() => this.edit("Порядок глав", (m) => m.moveChapter(c.id, -1))));
					menu.addItem((i) => i.setTitle("Нижче").setIcon("arrow-down").onClick(() => this.edit("Порядок глав", (m) => m.moveChapter(c.id, 1))));
					menu.addSeparator();
					for (const [g2] of groups) {
						if (g2 === (getString(c.node, "group") ?? "")) continue;
						const gt = g2 ? plain(this.text("chapter_group", g2, "title")) || g2 : "(без групи)";
						menu.addItem((i) => i.setTitle(`У групу «${gt}»`).setIcon("folder-input").onClick(() => this.edit("Група глави", (m) => m.setChapterGroup(c.id, g2))));
					}
					menu.addSeparator();
					menu.addItem((i) => i.setTitle("Перейменувати файл…").setIcon("pencil").onClick(() => this.renameChapter(c.id)));
					menu.addItem((i) =>
						i.setTitle("Видалити главу").setIcon("trash").onClick(() =>
							new ConfirmModal(this.app, `Видалити главу «${title}» і всі її квести?`, () => this.edit("Видалити главу", (m) => m.deleteChapter(c.id))).open(),
						),
					);
					menu.showAtMouseEvent(e);
				};
			}
		}
		const foot = el.createDiv("ftbq-sidebar-foot");
		const addGroup = foot.createEl("button", { text: "+ Група" });
		addGroup.onclick = () => new TextPrompt(this.app, "Назва нової групи глав", "", (v) => this.edit("Нова група", (m) => m.createChapterGroup(v))).open();
		const tables = foot.createEl("button", { text: "🎁 Таблиці" });
		tables.onclick = () => new RewardTablesModal(this.app, this).open();
		const settings = foot.createEl("button", { text: "⚙ Файл" });
		settings.onclick = () => new FileSettingsModal(this.app, this).open();
	}

	private applyPanels(): void {
		this.sidebarEl.toggleClass("is-collapsed", !this.showChapters);
		this.inspectorEl.toggleClass("is-collapsed", !this.showInspector);
	}

	private renderToolbar(): void {
		const el = this.toolbarEl;
		el.empty();
		const btn = (label: string, title: string, fn: () => void, disabled = false) => {
			const b = el.createEl("button", { text: label, attr: { "aria-label": title } });
			b.disabled = disabled;
			b.onclick = fn;
			return b;
		};
		btn("☰", "Список глав", () => {
			this.showChapters = !this.showChapters;
			this.applyPanels();
		}).toggleClass("is-active", this.showChapters);
		el.createSpan({ cls: "ftbq-title", text: this.chapterTitle(this.chapterId) });
		const dirty = this.store.dirtyPaths().length;
		const conflicts = this.plugin.sync?.conflicts.size ?? 0;
		const save = btn(dirty ? `💾 ${dirty}` : "💾", dirty ? `Зберегти ${dirty} файл(и) (Ctrl+S)` : "Усе збережено", () => void this.plugin.save(), !dirty);
		if (dirty) save.addClass("mod-cta");
		btn("↶", "Скасувати (Ctrl+Z)", () => this.store.undo(), !this.store.canUndo());
		btn("↷", "Повторити (Ctrl+Shift+Z)", () => this.store.redo(), !this.store.canRedo());
		btn("＋", "Новий квест у центрі (або подвійний клік по полотну)", () => {
			const c = this.canvas!.viewCenter();
			this.createQuestAt(c.x, c.y);
		}, !this.chapterId);
		btn("⤢", "Вмістити все (F)", () => this.canvas?.fit());
		btn("✔", "Перевірити квести", () => this.plugin.showValidation());
		if (conflicts) btn(`⚠ ${conflicts}`, "Файли змінено на диску", () => this.plugin.showConflicts()).addClass("mod-warning");
		btn("?", "МИША (як у FTB Quests)\nЛКМ по квесту — відкрити властивості · перетяг квесту — рух (Shift/Alt — без сітки)\nCtrl+ЛКМ — додати/прибрати з виділення · Alt+ЛКМ — властивості\nПравий Alt+ЛКМ по квесту — копіювати ID\nКолесико (клік) по квесту/зображенню — взяти й переміщувати; наступний клік — поставити, ПКМ/Esc — скасувати\nКолесико+перетяг або Alt+ЛКМ+перетяг — рамка (Ctrl — перемкнути в рамці)\nЛКМ/ПКМ+перетяг по порожньому — рух полотна\nКолесо — прокрутка · Shift+колесо — вбік · Ctrl+колесо — масштаб\nПКМ по порожньому — новий квест з типом завдання, зображення, вставити\nВиділи квести → ПКМ по іншому — додати/прибрати залежності\nCtrl+перетяг з квесту на квест — залежність · подвійний клік — новий квест\n\nКЛАВІШІ\nCtrl+A — усе · Ctrl+D — зняти виділення · Esc — скасувати\nCtrl+C — копіювати · Ctrl+V — вставити · Ctrl+Shift+V — без залежностей · Ctrl+Alt+V — як посилання\nDel — видалити (з підтвердженням) · Shift+Del — одразу\nСтрілки — прокрутка; під час переміщення або з Ctrl — рух виділених (0.5, Shift — 0.1)\nCtrl+Z / Ctrl+Y — undo/redo · Ctrl+S — зберегти · Ctrl+T — таблиці нагород\nCtrl+F — пошук квесту · Ctrl+R — сітка · Ctrl+P — налаштування\nTab / Shift+Tab — наступна/попередня глава · Space або F — вмістити\n- / = — масштаб · 0 — скинути масштаб", () => undefined).addClass("ftbq-help");
		btn("ⓘ", "Панель властивостей", () => {
			this.showInspector = !this.showInspector;
			this.applyPanels();
		}).toggleClass("is-active", this.showInspector);
	}

	// ----- inspector -------------------------------------------------------

	private currentInspectorKey(): string {
		if (this.selectedEdge) return `edge:${this.selectedEdge.questId}>${this.selectedEdge.depId}`;
		return this.selection.length ? `sel:${this.selection.join(",")}` : `chapter:${this.chapterId}`;
	}

	private renderInspector(): void {
		const el = this.inspectorEl;
		if (el.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
		el.empty();
		this.inspectorKey = this.currentInspectorKey();
		const index = this.store.index();
		if (this.selectedEdge) {
			const e = this.selectedEdge;
			el.createEl("h4", { text: "Залежність" });
			const dep = index.get(e.depId);
			const q = index.get(e.questId);
			el.createEl("p", { text: `«${q ? this.questLabel(q.node) : e.questId}» вимагає «${dep ? this.questLabel(dep.node) : e.depId}»` });
			new Setting(el).addButton((b) => b.setButtonText("Видалити залежність").setWarning().onClick(() => this.edit("Видалити залежність", (m) => m.removeDependency(e.questId, e.depId))));
			return;
		}
		const quests = this.selectedQuests();
		if (this.selection.length > 1) {
			el.createEl("h4", { text: `Вибрано: ${this.selection.length}` });
			if (quests.length > 1) {
				el.createEl("p", { cls: "ftbq-muted", text: "ПКМ по іншому квесту — зробити його залежним від виділених (або навпаки)." });
				new Setting(el).addButton((b) =>
					b.setButtonText("Ланцюжок у порядку виділення").setTooltip("Кожен наступний вимагає попередній").onClick(() =>
						this.edit("Ланцюжок залежностей", (m) => {
							for (let i = 1; i < quests.length; i++) if (!this.hasDep(quests[i]!, quests[i - 1]!)) m.addDependency(quests[i]!, quests[i - 1]!);
						}),
					),
				);
				new Setting(el).addButton((b) =>
					b.setButtonText("Прибрати залежності між виділеними").onClick(() =>
						this.edit("Прибрати залежності", (m) => {
							for (const a of quests) for (const d of quests) if (this.hasDep(a, d)) m.removeDependency(a, d);
						}),
					),
				);
				const host = this.fieldHost(`Властивість (${quests.length})`, (m, k, v) => {
					for (const q of quests) m.putField(q, k, v);
				});
				this.shapeSetting(el, "Форма", "", (v) => this.edit("Форма", (m) => quests.forEach((q) => (v ? m.setField(q, "shape", str(v)) : m.removeField(q, "shape")))));
				const first = this.store.index().get(quests[0]!)!.node;
				renderFields(this.section(el, "Спільні властивості (значення першого)"), first, QUEST_FIELDS.filter((f) => f.type !== "icon" && f.type !== "tags"), host);
			}
			new Setting(el)
				.addButton((b) => b.setButtonText("Дублювати").onClick(() => this.duplicateSelection()))
				.addButton((b) => b.setButtonText("Видалити всі").setWarning().onClick(() => this.deleteSelection()));
			return;
		}
		const imgSel = /^img:(\d+)$/.exec(this.selection[0] ?? "");
		if (imgSel && this.chapterId) return this.imageInspector(this.chapterId, Number(imgSel[1]));
		const sel = this.selection[0] ? index.get(this.selection[0]) : undefined;
		if (sel?.kind === "quest") return this.questInspector(sel);
		if (sel?.kind === "quest_link") return this.linkInspector(sel);
		this.chapterInspector();
	}

	private field(el: HTMLElement, label: string, value: string, commit: (v: string) => void, multiline = false): void {
		const s = new Setting(el).setName(label);
		s.settingEl.addClass("ftbq-field");
		const input = multiline ? s.controlEl.createEl("textarea") : s.controlEl.createEl("input", { type: "text" });
		input.value = value;
		input.addEventListener("change", () => {
			if (input.value !== value) commit(input.value);
		});
		if (!multiline) input.addEventListener("keydown", (e) => (e as KeyboardEvent).key === "Enter" && input.blur());
	}

	/** FieldHost whose commits go to `apply` inside one transaction. */
	fieldHost(label: string, apply: (m: GraphMutator, key: string, value: SnbtNode | undefined) => void): FieldHost {
		return {
			commit: (changes) =>
				this.edit(label, (m) => {
					for (const [k, v] of Object.entries(changes)) apply(m, k, v);
				}),
			pickItem: (done) => new ItemPicker(this.app, this.plugin, done).open(),
			pickQuest: (done) => new QuestPicker(this.app, this, done).open(),
			questLabel: (id) => {
				const q = this.store.index().get(id);
				return q?.kind === "quest" ? `${this.questLabel(q.node)} — ${this.chapterTitle(q.parent)}` : `⚠ ${id}`;
			},
			rewardTables: () => this.rewardTables(),
		};
	}

	rewardTables(): { id: string; label: string }[] {
		return this.store
			.index()
			.ofKind("reward_table")
			.map((t) => ({ id: t.id, label: plain(this.text("reward_table", t.id, "title")) || t.file.replace(/^reward_tables\/|\.snbt$/g, "") }));
	}

	/** Lang fields (title, subtitle, description) of an object. */
	private langFields(el: HTMLElement, kind: keyof typeof LANG_FIELDS & Parameters<GraphMutator["getText"]>[0], id: string): void {
		for (const lf of LANG_FIELDS[kind] ?? []) {
			this.field(
				el,
				lf.label,
				this.text(kind, id, lf.field),
				(v) => this.edit(lf.label, (m) => m.setText(kind, id, lf.field, !v.trim() ? undefined : lf.multiline ? v.split("\n") : v)),
				lf.multiline,
			);
		}
	}

	/** Collapsible section; remembers its open state per title. */
	private section(el: HTMLElement, title: string, open = false): HTMLElement {
		const d = el.createEl("details", { cls: "ftbq-section" });
		d.open = this.openSections.has(title) || (open && !this.closedSections.has(title));
		d.createEl("summary", { text: title });
		d.addEventListener("toggle", () => {
			if (d.open) {
				this.openSections.add(title);
				this.closedSections.delete(title);
			} else {
				this.openSections.delete(title);
				this.closedSections.add(title);
			}
		});
		return d.createDiv("ftbq-section-body");
	}

	private imageInspector(chapterId: string, i: number): void {
		const el = this.inspectorEl;
		const img = getList(this.store.index().get(chapterId)!.node, "images")?.items[i];
		if (img?.kind !== "compound") return this.chapterInspector();
		el.createEl("h4", { text: "Зображення" });
		el.createDiv({ cls: "ftbq-muted", text: "Перетягни виділене зображення, щоб перемістити (Alt — без сітки)." });
		renderFields(el, img, IMAGE_FIELDS, this.fieldHost("Зображення", (m, k, v) => m.setImageField(chapterId, i, k, v)));
		new Setting(el)
			.addButton((b) => b.setButtonText("Дублювати").onClick(() => this.edit("Дублювати зображення", (m) => m.duplicateImage(chapterId, i))))
			.addButton((b) => b.setButtonText("Видалити").setWarning().onClick(() => this.deleteSelection()));
	}

	private selectedQuests(): string[] {
		return this.selection.filter((id) => this.store.index().get(id)?.kind === "quest");
	}

	/** Quest ids behind the selection, resolving quest links to their targets. */
	private selectedQuestTargets(): string[] {
		return [
			...new Set(
				this.selection.flatMap((id) => {
					const o = this.store.index().get(id);
					if (o?.kind === "quest") return [id];
					const t = o?.kind === "quest_link" ? getString(o.node, "linked_quest") : undefined;
					return t ? [t] : [];
				}),
			),
		];
	}

	private hasDep(questId: string, depId: string): boolean {
		const q = this.store.index().get(questId);
		return !!q && stringItems(getList(q.node, "dependencies")).includes(depId);
	}

	/** Makes `target` require every selected quest (or, reversed, every selected quest require `target`). */
	private linkSelectionTo(target: string, reverse: boolean): void {
		const sel = this.selectedQuestTargets().filter((id) => id !== target);
		if (!sel.length) return;
		this.edit("Додати залежності", (m) => {
			for (const s of sel) {
				const [q, d] = reverse ? [s, target] : [target, s];
				if (!this.hasDep(q, d)) m.addDependency(q, d);
			}
		});
	}

	private chapterInspector(): void {
		const el = this.inspectorEl;
		const c = this.chapterId ? this.store.index().get(this.chapterId) : undefined;
		if (!c) {
			el.createEl("p", { text: "Немає глав. Створи першу кнопкою «+» зліва.", cls: "ftbq-muted" });
			return;
		}
		el.createEl("h4", { text: "Глава" });
		this.langFields(el, "chapter", c.id);
		new Setting(el).setName("Файл").setDesc(c.file).addButton((b) => b.setButtonText("Перейменувати").onClick(() => this.renameChapter(c.id)));
		new Setting(el).setName("Група").addDropdown((d) => {
			d.addOption("", "(без групи)");
			for (const g of this.store.index().ofKind("chapter_group")) d.addOption(g.id, plain(this.text("chapter_group", g.id, "title")) || g.id);
			d.setValue(getString(c.node, "group") ?? "");
			d.onChange((v) => this.edit("Група глави", (m) => m.setChapterGroup(c.id, v)));
		});
		new Setting(el)
			.setName("Порядок у книзі")
			.addExtraButton((b) => b.setIcon("arrow-up").setTooltip("Вище").onClick(() => this.edit("Порядок глав", (m) => m.moveChapter(c.id, -1))))
			.addExtraButton((b) => b.setIcon("arrow-down").setTooltip("Нижче").onClick(() => this.edit("Порядок глав", (m) => m.moveChapter(c.id, 1))));
		const host = this.fieldHost("Властивість глави", (m, k, v) => m.putField(c.id, k, v));
		renderFields(this.section(el, "Властивості", true), c.node, CHAPTER_FIELDS, host);
		this.imageList(el, c.id, c.node);
		el.createEl("p", { cls: "ftbq-muted", text: `${chapterQuests(c.node).length} квестів · id ${c.id}` });
	}

	private imageList(el: HTMLElement, chapterId: string, chapter: CompoundNode): void {
		const images = getList(chapter, "images")?.items ?? [];
		const body = this.section(el, `Зображення (${images.length})`);
		images.forEach((img, i) => {
			if (img.kind !== "compound") return;
			const box = body.createDiv("ftbq-child");
			const head = box.createDiv("ftbq-child-head");
			head.createSpan({ cls: "ftbq-item", text: (getString(img, "image") ?? "?").split("/").pop()! });
			const dup = head.createEl("button", { text: "⧉", cls: "ftbq-mini", attr: { "aria-label": "Дублювати" } });
			dup.onclick = () => this.edit("Дублювати зображення", (m) => m.duplicateImage(chapterId, i));
			const del = head.createEl("button", { text: "✕", cls: "ftbq-mini", attr: { "aria-label": "Видалити" } });
			del.onclick = () => this.edit("Видалити зображення", (m) => m.removeImage(chapterId, i));
			const det = box.createEl("details");
			det.createEl("summary", { text: "параметри" });
			renderFields(det, img, IMAGE_FIELDS, this.fieldHost("Зображення", (m, k, v) => m.setImageField(chapterId, i, k, v)));
		});
		new Setting(body).addButton((b) =>
			b.setButtonText("+ Зображення").onClick(() =>
				new TextPrompt(this.app, "Текстура (namespace:textures/....png)", "minecraft:textures/block/stone.png", (v) => {
					const c = this.canvas!.viewCenter();
					this.edit("Додати зображення", (m) => m.addImage(chapterId, v, m.snap(c.x), m.snap(c.y)));
				}, true).open(),
			),
		);
	}

	private shapeSetting(el: HTMLElement, name: string, value: string, commit: (v: string) => void): void {
		new Setting(el).setName(name).addDropdown((d) => {
			for (const s of SHAPES) d.addOption(s, s || "(за замовчуванням)");
			d.setValue(SHAPES.includes(value) ? value : "");
			d.onChange(commit);
		});
	}

	private questInspector(q: IndexedObject): void {
		const el = this.inspectorEl;
		const id = q.id;
		const n = q.node;
		el.createEl("h4", { text: "Квест" });
		this.langFields(el, "quest", id);
		el.createDiv({ cls: "ftbq-muted", text: "Коди кольорів: &6 золотий, &7 сірий, &l жирний, &r скинути" });

		this.shapeSetting(el, "Форма", getString(n, "shape") ?? "", (v) => this.edit("Форма", (m) => (v ? m.setField(id, "shape", str(v)) : m.removeField(id, "shape"))));

		// dependencies
		const deps = stringItems(getList(n, "dependencies"));
		el.createEl("h5", { text: `Залежності (${deps.length})` });
		for (const d of deps) {
			const t = this.store.index().get(d);
			const s = new Setting(el).setName(t ? this.questLabel(t.node) : `⚠ ${d}`).setDesc(t && t.parent !== this.chapterId ? `з іншої глави: ${this.chapterTitle(t.parent)}` : "");
			if (t) s.addExtraButton((b) => b.setIcon("crosshair").setTooltip("Показати").onClick(() => this.reveal(d)));
			s.addExtraButton((b) => b.setIcon("x").setTooltip("Прибрати").onClick(() => this.edit("Прибрати залежність", (m) => m.removeDependency(id, d))));
		}
		new Setting(el).addButton((b) =>
			b.setButtonText("+ Залежність з будь-якої глави…").onClick(() => new QuestPicker(this.app, this, (dep) => this.edit("Додати залежність", (m) => m.addDependency(id, dep))).open()),
		);

		// tasks & rewards
		this.childList(el, "Завдання", "tasks", n, id);
		this.childList(el, "Нагороди", "rewards", n, id);

		renderFields(this.section(el, "Усі властивості квесту"), n, QUEST_FIELDS, this.fieldHost("Властивість квесту", (m, k, v) => m.putField(id, k, v)));

		new Setting(el)
			.addButton((b) => b.setButtonText("Дублювати").onClick(() => this.duplicateSelection()))
			.addButton((b) => b.setButtonText("Видалити").setWarning().onClick(() => this.deleteSelection()));
		el.createDiv({ cls: "ftbq-muted", text: `id ${id}` });
	}

	/** One-line summary of a task / reward for its header. */
	private childSummary(t: CompoundNode): string {
		const stack = getCompound(t, "item");
		if (stack) {
			const count = getNumber(t, "count") ?? 1;
			return `${getString(stack, "id") ?? "?"}${count > 1 ? ` ×${count}` : ""}`;
		}
		for (const k of ["entity", "dimension", "biome", "structure", "advancement", "to_observe", "stat", "stage", "command", "description"]) {
			const v = getString(t, k);
			if (v) return v + (getNumber(t, "value") && getNumber(t, "value")! > 1 ? ` ×${getNumber(t, "value")}` : "");
		}
		for (const k of ["xp", "xp_levels", "value", "amount"]) {
			const v = getNumber(t, k);
			if (v !== undefined) return `${k}: ${v}`;
		}
		const table = idOf(get(t, "table_id"));
		if (table) return this.rewardTables().find((r) => r.id === table)?.label ?? `⚠ ${table}`;
		return "";
	}

	private childList(el: HTMLElement, title: string, key: "tasks" | "rewards", quest: CompoundNode, questId: string): void {
		const items = (getList(quest, key)?.items ?? []).filter((t): t is CompoundNode => t.kind === "compound");
		const isTask = key === "tasks";
		el.createEl("h5", { text: `${title} (${items.length})` });
		items.forEach((t, i) => {
			const tid = getString(t, "id")!;
			const type = getString(t, "type") ?? "?";
			const def = isTask ? taskType(type) : rewardType(type);
			const box = el.createDiv("ftbq-child");
			const head = box.createDiv("ftbq-child-head");
			head.createSpan({ cls: "ftbq-badge", text: def?.label ?? type }).style.setProperty("--badge", TASK_COLORS[type] ?? "#8b949e");
			head.createSpan({ cls: "ftbq-item", text: this.childSummary(t) });
			const btn = (text: string, label: string, fn: () => void, disabled = false) => {
				const b = head.createEl("button", { text, cls: "ftbq-mini", attr: { "aria-label": label } });
				b.disabled = disabled;
				b.onclick = fn;
			};
			btn("↑", "Вище", () => this.edit("Порядок", (m) => m.moveChild(tid, -1)), i === 0);
			btn("↓", "Нижче", () => this.edit("Порядок", (m) => m.moveChild(tid, 1)), i === items.length - 1);
			btn("✕", "Видалити", () => this.edit(`Видалити ${type}`, (m) => m.removeTaskOrReward(tid)));
			const key2 = `${key}:${tid}`;
			const det = box.createEl("details");
			det.open = this.openSections.has(key2);
			det.addEventListener("toggle", () => (det.open ? this.openSections.add(key2) : this.openSections.delete(key2)));
			det.createEl("summary", { text: "параметри" });
			const host = this.fieldHost(def?.label ?? type, (m, k, v) => m.putField(tid, k, v));
			this.langFields(det, isTask ? "task" : "reward", tid);
			if (def) renderFields(det, t, def.fields, host);
			else det.createDiv({ cls: "ftbq-muted", text: `Невідомий тип «${type}»: поля збережено як є.` });
			renderFields(det, t, isTask ? TASK_COMMON : REWARD_COMMON, host);
		});
		new Setting(el).addButton((b) =>
			b.setButtonText(isTask ? "+ Завдання" : "+ Нагорода").onClick((evt) => {
				const menu = new Menu();
				for (const d of isTask ? TASK_TYPES : REWARD_TYPES) {
					menu.addItem((mi) =>
						mi.setTitle(d.label).onClick(() => {
							const add = (fields: Record<string, SnbtNode>) =>
								this.edit(isTask ? "Додати завдання" : "Додати нагороду", (m) => (isTask ? m.addTask(questId, fields) : m.addReward(questId, fields)));
							if (d.type === "item") {
								new ItemPicker(this.app, this.plugin, (item) => add(isTask ? itemTask(item) : itemReward(item))).open();
							} else {
								const tid = add(defaultFields(d));
								if (tid) this.openSections.add(`${key}:${tid}`);
							}
						}),
					);
				}
				menu.showAtMouseEvent(evt);
			}),
		);
	}

	private linkInspector(l: IndexedObject): void {
		const el = this.inspectorEl;
		const target = getString(l.node, "linked_quest") ?? "";
		const t = this.store.index().get(target);
		el.createEl("h4", { text: "Посилання на квест" });
		el.createEl("p", { text: t ? `${this.questLabel(t.node)} — ${this.chapterTitle(t.parent)}` : `⚠ квест ${target} не існує` });
		const s = new Setting(el);
		if (t) s.addButton((b) => b.setButtonText("Відкрити оригінал").onClick(() => this.reveal(target)));
		s.addButton((b) => b.setButtonText("Прибрати посилання").setWarning().onClick(() => this.edit("Прибрати посилання", (m) => m.unlinkQuest(l.id))));
	}

	chapterTitle(chapterId: string | undefined): string {
		if (!chapterId) return "";
		const c = this.store.index().get(chapterId);
		return plain(this.text("chapter", chapterId, "title")) || (c ? (getString(c.node, "filename") ?? chapterId) : chapterId);
	}

	// ----- actions ---------------------------------------------------------

	private moveNodes(moves: { id: string; x: number; y: number }[], snap: boolean): void {
		this.edit(`Перемістити ${moves.length}`, (m) => {
			for (const mv of moves) {
				const img = /^img:(\d+)$/.exec(mv.id);
				if (img && this.chapterId) {
					m.setImageField(this.chapterId, Number(img[1]), "x", double(snap ? m.snap(mv.x) : mv.x));
					m.setImageField(this.chapterId, Number(img[1]), "y", double(snap ? m.snap(mv.y) : mv.y));
					continue;
				}
				const o = this.store.index().get(mv.id);
				if (o?.kind === "quest") m.moveQuest(mv.id, mv.x, mv.y, { snap, avoidCollisions: moves.length === 1 });
				else if (o?.kind === "quest_link") {
					m.setField(mv.id, "x", double(snap ? m.snap(mv.x) : mv.x));
					m.setField(mv.id, "y", double(snap ? m.snap(mv.y) : mv.y));
				}
			}
		});
		// The canvas moved nodes optimistically: resync with the real data (also on error / no-op).
		this.canvas?.setData(this.buildData());
	}

	/** Edits a task/reward item stack in place (looked up fresh inside the transaction). */
	private editStack(id: string, label: string, fn: (stack: CompoundNode) => void): void {
		this.edit(label, (m) => {
			const o = this.store.index().get(id);
			const current = o ? getCompound(o.node, "item") : undefined;
			if (!current) throw new GraphError("Предмет не знайдено");
			const copy = cloneNode(current);
			fn(copy);
			m.setField(id, "item", copy);
		});
	}

	/** Runs a store transaction, showing graph errors (cycles, ...) as notices. */
	private edit<T>(label: string, fn: (m: GraphMutator) => T): T | undefined {
		try {
			return this.store.transact(label, fn);
		} catch (e) {
			new Notice(e instanceof GraphError ? e.message : `Помилка: ${(e as Error).message}`, 6000);
			if (!(e instanceof GraphError)) console.error(e);
			return undefined;
		}
	}

	openChapter(id: string): void {
		if (this.chapterId === id) return;
		this.chapterId = id;
		this.plugin.settings.lastChapter = id;
		void this.plugin.saveData(this.plugin.settings);
		this.canvas?.setSelection([]);
		this.selection = [];
		this.selectedEdge = undefined;
		this.refresh();
		this.canvas?.fit();
	}

	/** Opens the chapter containing a quest and selects it. */
	reveal(questId: string): void {
		const q = this.store.index().get(questId);
		if (!q?.parent) return;
		this.openChapter(q.parent);
		this.canvas?.setSelection([questId], true);
		this.canvas?.centerOn(questId);
	}

	private createQuestAt(x: number, y: number): void {
		if (!this.chapterId) return;
		const chapterId = this.chapterId;
		const id = this.edit("Новий квест", (m) => m.createQuest(chapterId, { x, y }));
		if (!id) return;
		this.canvas?.setSelection([id], true);
		window.setTimeout(() => this.inspectorEl.querySelector<HTMLInputElement>("input")?.focus(), 30);
	}

	/** Drag from → to: "to" requires "from". Links resolve to their quests. */
	private connect(fromNode: string, toNode: string): void {
		const resolve = (id: string) => {
			const o = this.store.index().get(id);
			return o?.kind === "quest_link" ? getString(o.node, "linked_quest") : id;
		};
		const from = resolve(fromNode);
		const to = resolve(toNode);
		if (!from || !to) return;
		const toQuest = this.store.index().get(to);
		if (toQuest && stringItems(getList(toQuest.node, "dependencies")).includes(from)) {
			new Notice("Ця залежність уже є. Щоб прибрати — клікни по лінії й натисни Delete.");
			return;
		}
		this.edit("Додати залежність", (m) => m.addDependency(to, from));
	}

	private deleteSelection(): void {
		const ids = [...this.selection];
		if (!ids.length) return;
		this.edit(`Видалити ${ids.length}`, (m) => {
			const imgs = ids.flatMap((id) => /^img:(\d+)$/.exec(id)?.[1] ?? []).map(Number).sort((a, b) => b - a);
			for (const i of imgs) m.removeImage(this.chapterId!, i);
			for (const id of ids) {
				const o = this.store.index().get(id);
				if (o?.kind === "quest") m.deleteQuest(id);
				else if (o?.kind === "quest_link") m.unlinkQuest(id);
			}
		});
		this.canvas?.setSelection([], true);
	}

	private duplicateSelection(): void {
		const ids = this.selection.filter((id) => this.store.index().get(id)?.kind === "quest");
		if (!ids.length) return;
		const copies = this.edit("Дублювати", (m) => ids.map((id) => m.duplicateQuest(id)));
		if (copies) this.canvas?.setSelection(copies, true);
	}

	private renameChapter(chapterId: string): void {
		const c = this.store.index().get(chapterId);
		new TextPrompt(this.app, "Нове ім'я файлу глави (a-z, 0-9, _)", getString(c?.node ?? ({ kind: "compound", entries: [] } as CompoundNode), "filename") ?? "", (v) =>
			this.edit("Перейменувати главу", (m) => m.renameChapterFile(chapterId, v)),
		).open();
	}

	// ----- FTB clipboard (Ctrl+C / Ctrl+V): quest ids as hex, images as a private token ----------

	private async readClipboard(): Promise<string> {
		try {
			return (await navigator.clipboard.readText()).trim();
		} catch {
			return this.clipboardFallback;
		}
	}

	private clipboardFallback = "";

	private writeClipboard(text: string, what: string): void {
		this.clipboardFallback = text;
		void navigator.clipboard.writeText(text).catch(() => undefined);
		new Notice(`Скопійовано: ${what}`);
	}

	/** FTB copyObjectsToClipboard: the single selected object, else the hovered one. */
	private copySelected(): void {
		if (this.selection.length > 1) return void new Notice("Не можна копіювати кілька об'єктів одразу (як і в FTB)");
		const id = this.selection[0] ?? this.canvas?.hovered();
		if (id) this.copyObject(id);
	}

	private copyObject(id: string): void {
		const img = /^img:(\d+)$/.exec(id);
		if (img) return this.writeClipboard(`ftbq-image:${this.chapterId}:${img[1]}`, "зображення");
		const o = this.store.index().get(id);
		const qid = o?.kind === "quest_link" ? getString(o.node, "linked_quest") : o?.kind === "quest" ? id : undefined;
		if (qid) this.writeClipboard(qid, this.questLabel(this.store.index().get(qid)!.node));
	}

	private parseClip(clip: string): { quest?: string; image?: { chapter: string; index: number } } {
		const img = /^ftbq-image:([0-9A-F]{16}):(\d+)$/.exec(clip);
		if (img) return { image: { chapter: img[1]!, index: Number(img[2]) } };
		const hex = /^#?([0-9A-Fa-f]{16})$/.exec(clip)?.[1]?.toUpperCase();
		return hex && this.store.index().get(hex)?.kind === "quest" ? { quest: hex } : {};
	}

	/** FTB paste: `mode` = "deps" (Ctrl+V), "nodeps" (Ctrl+Shift+V), "link" (Ctrl+Alt+V). */
	private async paste(mode: "deps" | "nodeps" | "link", at?: { x: number; y: number }): Promise<void> {
		const chapterId = this.chapterId;
		if (!chapterId || !this.canvas) return;
		const pos = at ?? this.canvas.cursorWorld();
		const c = this.parseClip(await this.readClipboard());
		if (c.quest) {
			const qid = c.quest;
			const id =
				mode === "link"
					? this.edit("Вставити посилання", (m) => m.linkQuest(chapterId, qid, pos.x, pos.y))
					: this.edit("Вставити квест", (m) => m.copyQuest(qid, chapterId, pos.x, pos.y, mode === "deps"));
			if (id) this.canvas.setSelection([id], true);
		} else if (c.image && mode !== "link") {
			const img = c.image;
			this.edit("Вставити зображення", (m) => m.copyImage(img.chapter, img.index, chapterId, pos.x, pos.y));
		} else new Notice("У буфері немає id квесту чи зображення");
	}

	// ----- context menus (FTB QuestButton / QuestPanel / ChapterImageButton) -------------------

	private async contextMenu(evt: MouseEvent, t: { node?: GNode; edge?: GEdge; image?: GImage; world: { x: number; y: number } }): Promise<void> {
		const menu = new Menu();
		const chapterId = this.chapterId;
		if (t.node) {
			const n = t.node;
			const target = n.kind === "link" ? n.target! : n.id;
			const selected = this.selectedQuestTargets();
			const others = selected.filter((id) => id !== target);
			if (others.length && !this.selection.includes(n.id)) {
				// FTB addMultiSelectionContextMenuItems, clicked quest not in the selection.
				menu.addItem((i) => i.setTitle(`Додати виділені (${others.length}) як залежності`).setIcon("plus").onClick(() => this.linkSelectionTo(target, false)));
				menu.addItem((i) =>
					i.setTitle("Прибрати виділені із залежностей").setIcon("minus").onClick(() =>
						this.edit("Прибрати залежності", (m) => others.forEach((o) => this.hasDep(target, o) && m.removeDependency(target, o))),
					),
				);
				menu.addItem((i) => i.setTitle("Додати як залежність до виділених").setIcon("plus").onClick(() => this.linkSelectionTo(target, true)));
				menu.addItem((i) =>
					i.setTitle("Прибрати як залежність з виділених").setIcon("minus").onClick(() =>
						this.edit("Прибрати залежності", (m) => others.forEach((o) => this.hasDep(o, target) && m.removeDependency(o, target))),
					),
				);
				this.selectionHints(menu);
				menu.showAtMouseEvent(evt);
				return;
			}
			if (this.selection.length > 1 && this.selection.includes(n.id)) {
				// FTB: clicked quest is part of a multi-selection.
				const quests = this.selectedQuests();
				menu.addItem((i) => i.setTitle("Перемістити").setIcon("move").onClick(() => this.canvas?.startMoving()));
				menu.addItem((i) => i.setTitle("Додати нагороду всім…").setIcon("gift").onClick(() => this.addRewardToAll(quests, evt)));
				menu.addItem((i) =>
					i.setTitle("Прибрати нагороди в усіх").setIcon("x").onClick(() =>
						this.edit("Прибрати нагороди", (m) => {
							for (const q of quests) for (const r of getList(this.store.index().get(q)!.node, "rewards")?.items ?? []) if (r.kind === "compound") m.removeTaskOrReward(getString(r, "id")!);
						}),
					),
				);
				menu.addItem((i) =>
					i.setTitle("Змінити розмір усім…").setIcon("settings").onClick(() =>
						new TextPrompt(this.app, "Розмір (0.0625–8)", String(getNumber(this.store.index().get(quests[0]!)!.node, "size") || 1), (v) => {
							const size = Math.min(8, Math.max(0.0625, Number(v) || 1));
							this.edit("Розмір", (m) => quests.forEach((q) => m.setField(q, "size", double(size))));
						}, true).open(),
					),
				);
				menu.addItem((i) => i.setTitle("Дублювати").setIcon("copy").onClick(() => this.duplicateSelection()));
				menu.addItem((i) => i.setTitle(`Видалити (${this.selection.length})`).setIcon("trash").onClick(() => this.confirmDelete()));
				this.selectionHints(menu);
				menu.showAtMouseEvent(evt);
				return;
			}
			if (!this.selection.includes(n.id)) this.canvas?.setSelection([n.id], true);
			menu.addItem((i) => i.setTitle("Редагувати").setIcon("pencil").onClick(() => this.showProperties()));
			menu.addItem((i) => i.setTitle("Перемістити").setIcon("move").setSection("move").onClick(() => this.canvas?.startMoving()));
			menu.addItem((i) => i.setTitle("Копіювати ID").setIcon("clipboard-copy").onClick(() => this.copyObject(n.id)));
			if (n.kind === "link") {
				menu.addItem((i) => i.setTitle("Відкрити оригінал").setIcon("external-link").onClick(() => this.reveal(n.target!)));
				menu.addItem((i) => i.setTitle("Прибрати посилання").setIcon("unlink").onClick(() => this.edit("Прибрати посилання", (m) => m.unlinkQuest(n.id))));
			} else {
				menu.addItem((i) => i.setTitle("Дублювати").setIcon("copy").onClick(() => this.duplicateSelection()));
				menu.addItem((i) =>
					i.setTitle("Прибрати всі залежності").setIcon("unlink").onClick(() =>
						this.edit("Прибрати залежності", (m) => {
							for (const d of stringItems(getList(this.store.index().get(n.id)!.node, "dependencies"))) m.removeDependency(n.id, d);
						}),
					),
				);
				menu.addSeparator();
				for (const c of this.chapters()) {
					if (c.id === chapterId) continue;
					menu.addItem((i) => i.setTitle(`Перенести в «${this.chapterTitle(c.id)}»`).setIcon("folder-input").onClick(() => this.edit("Перенести квест", (m) => m.moveQuestToChapter(n.id, c.id))));
				}
			}
			menu.addSeparator();
			menu.addItem((i) => i.setTitle("Видалити").setIcon("trash").onClick(() => this.confirmDelete()));
		} else if (t.edge) {
			const e = t.edge;
			menu.addItem((i) => i.setTitle("Видалити залежність").setIcon("trash").onClick(() => this.edit("Видалити залежність", (m) => m.removeDependency(e.questId, e.depId))));
		} else if (t.image && chapterId) {
			const img = t.image;
			const id = imageId(img.index);
			menu.addItem((i) => i.setTitle(`«${img.label}»`).setDisabled(true));
			menu.addItem((i) =>
				i.setTitle("Редагувати").setIcon("pencil").onClick(() => {
					this.canvas?.setSelection([id], true);
					this.showProperties();
				}),
			);
			if (!img.locked) {
				menu.addItem((i) =>
					i.setTitle("Перемістити (середня кнопка)").setIcon("move").onClick(() => {
						if (!this.selection.includes(id)) this.canvas?.setSelection([...this.selection, id], true);
						this.canvas?.startMoving();
					}),
				);
			}
			menu.addItem((i) => i.setTitle("Копіювати").setIcon("clipboard-copy").onClick(() => this.copyObject(id)));
			menu.addItem((i) =>
				i.setTitle(img.locked ? "Розблокувати позицію" : "Заблокувати позицію").setIcon("lock").onClick(() =>
					this.edit("Блокування зображення", (m) => m.setImageField(chapterId, img.index, "position_locked", img.locked ? undefined : bool(true))),
				),
			);
			const tex = img.src ? this.plugin.assets?.get(img.src) : undefined;
			const tw = tex && "width" in tex ? Number(tex.width) : 0;
			const th = tex && "height" in tex ? Number(tex.height) : 0;
			if (tw && th && Math.abs(img.w / img.h - tw / th) > 0.01) {
				menu.addItem((i) => i.setTitle("Виправити пропорції (за шириною)").setIcon("image").onClick(() => this.edit("Пропорції", (m) => m.setImageField(chapterId, img.index, "height", double((img.w * th) / tw)))));
				menu.addItem((i) => i.setTitle("Виправити пропорції (за висотою)").setIcon("image").onClick(() => this.edit("Пропорції", (m) => m.setImageField(chapterId, img.index, "width", double((img.h * tw) / th)))));
			}
			menu.addItem((i) => i.setTitle("Видалити").setIcon("trash").onClick(() => new ConfirmModal(this.app, `Видалити зображення «${img.label}»?`, () => this.edit("Видалити зображення", (m) => m.removeImage(chapterId, img.index))).open()));
		} else if (chapterId) {
			// FTB QuestPanel: right click on empty space = new quest with a task of the chosen type.
			const g = this.store.gridScale;
			const at = { x: Math.round(t.world.x / g) * g, y: Math.round(t.world.y / g) * g };
			for (const d of TASK_TYPES) {
				menu.addItem((i) =>
					i.setTitle(d.label).setSection("create").onClick(() => {
						const create = (task: Record<string, SnbtNode>) => {
							const id = this.edit("Новий квест", (m) => m.createQuest(chapterId, { ...at, tasks: [task] }));
							if (id) this.canvas?.setSelection([id], true);
						};
						if (d.type === "item") new ItemPicker(this.app, this.plugin, (item) => create(itemTask(item))).open();
						else create(defaultFields(d));
					}),
				);
			}
			menu.addItem((i) =>
				i.setTitle("Зображення").setIcon("image").setSection("create").onClick(() =>
					new TextPrompt(this.app, "Текстура (namespace:textures/....png)", "minecraft:textures/block/stone.png", (v) => this.edit("Додати зображення", (m) => m.addImage(chapterId, v, at.x, at.y)), true).open(),
				),
			);
			const clip = this.parseClip(await this.readClipboard());
			if (clip.quest) {
				const label = this.questLabel(this.store.index().get(clip.quest)!.node);
				menu.addItem((i) => i.setTitle(`Вставити квест «${label}»`).setIcon("clipboard-paste").setSection("paste").onClick(() => void this.paste("deps", at)));
				if (stringItems(getList(this.store.index().get(clip.quest)!.node, "dependencies")).length)
					menu.addItem((i) => i.setTitle("Вставити квест (без залежностей)").setIcon("clipboard-paste").setSection("paste").onClick(() => void this.paste("nodeps", at)));
				menu.addItem((i) => i.setTitle("Вставити посилання на квест").setIcon("link").setSection("paste").onClick(() => void this.paste("link", at)));
			} else if (clip.image) {
				menu.addItem((i) => i.setTitle("Вставити зображення").setIcon("clipboard-paste").setSection("paste").onClick(() => void this.paste("deps", at)));
			}
			menu.addItem((i) =>
				i.setTitle("Посилання на квест з іншої глави…").setIcon("link").setSection("paste").onClick(() =>
					new QuestPicker(this.app, this, (qid) => this.edit("Додати посилання", (m) => m.linkQuest(chapterId, qid, at.x, at.y))).open(),
				),
			);
		}
		menu.showAtMouseEvent(evt);
	}

	private selectionHints(menu: Menu): void {
		menu.addSeparator();
		for (const h of ["Ctrl+A — виділити всі квести", "Ctrl+D — зняти виділення", "Ctrl+стрілки — рухати виділені"]) menu.addItem((i) => i.setTitle(h).setIcon("info").setDisabled(true));
	}

	private addRewardToAll(quests: string[], evt: MouseEvent): void {
		const menu = new Menu();
		for (const d of REWARD_TYPES) {
			menu.addItem((i) =>
				i.setTitle(d.label).onClick(() => {
					const add = (fields: () => Record<string, SnbtNode>) => this.edit("Нагорода всім", (m) => quests.forEach((q) => m.addReward(q, fields())));
					if (d.type === "item") new ItemPicker(this.app, this.plugin, (item) => add(() => itemReward(item))).open();
					else add(() => defaultFields(d));
				}),
			);
		}
		menu.showAtMouseEvent(evt);
	}

	/** FTB Alt+LMB / "Edit": shows the properties panel for the selection. */
	private showProperties(): void {
		if (!this.showInspector) {
			this.showInspector = true;
			this.applyPanels();
		}
		this.renderInspector();
	}

	/** FTB Delete (with confirmation) and Shift+Delete (force, no confirmation): selection, else hovered. */
	private confirmDelete(force = false): void {
		if (this.selectedEdge) {
			const se = this.selectedEdge;
			this.edit("Видалити залежність", (m) => m.removeDependency(se.questId, se.depId));
			return;
		}
		if (!this.selection.length) {
			const h = this.canvas?.hovered();
			if (!h) return;
			this.canvas?.setSelection([h], true);
		}
		if (force) return this.deleteSelection();
		const n = this.selection.length;
		const what = n > 1 ? `${n} об'єктів` : /^img:/.test(this.selection[0]!) ? "зображення" : `«${this.questLabel(this.store.index().get(this.selection[0]!)?.node ?? ({ kind: "compound", entries: [] } as CompoundNode))}»`;
		new ConfirmModal(this.app, `Видалити ${what}?`, () => this.deleteSelection()).open();
	}

	private cycleChapter(dir: number): void {
		const list = this.chapters();
		const i = list.findIndex((c) => c.id === this.chapterId);
		const next = list[(i + dir + list.length) % list.length];
		if (next) this.openChapter(next.id);
	}

	/**
	 * FTB Quests editor keys (FTBQuestsKeyMappings defaults), plus F = fit and Ctrl+Shift+Z = redo.
	 */
	private onKey(e: KeyboardEvent): void {
		const mod = e.ctrlKey || e.metaKey;
		const k = e.key.toLowerCase();
		const c = this.canvas;
		if (!c) return;
		const step = e.shiftKey ? 0.1 : 0.5; // FTB moveStep()
		const arrows: Record<string, [number, number]> = { arrowup: [0, -1], arrowdown: [0, 1], arrowleft: [-1, 0], arrowright: [1, 0] };
		let handled = true;
		if (k === "delete") this.confirmDelete(e.shiftKey);
		else if (k === "backspace" && !mod) this.confirmDelete(false);
		else if (k === "escape") {
			if (c.moving) c.cancelMoving();
			else c.setSelection([], true);
		} else if (arrows[k]) {
			const [dx, dy] = arrows[k]!;
			if ((c.moving || mod) && this.selection.length) c.nudge(dx * step, dy * step);
			else c.scrollBy(-dx * step * 4, -dy * step * 4);
		} else if (mod && k === "a") c.setSelection([...this.buildData().nodes.map((n) => n.id), ...this.buildData().images.map((i) => imageId(i.index))], true);
		else if (mod && k === "d") c.setSelection([], true);
		else if (mod && k === "c") this.copySelected();
		else if (mod && k === "v") void this.paste(e.altKey ? "link" : e.shiftKey ? "nodeps" : "deps");
		else if (mod && k === "z" && !e.shiftKey) this.store.undo();
		else if (mod && (k === "y" || (k === "z" && e.shiftKey))) this.store.redo();
		else if (mod && k === "s") void this.plugin.save();
		else if (mod && k === "t") new RewardTablesModal(this.app, this).open();
		else if (mod && k === "f") new QuestPicker(this.app, this, (q) => this.reveal(q)).open();
		else if (mod && k === "r") {
			c.showGrid = !c.showGrid;
			c.request();
		} else if (mod && k === "p") new FileSettingsModal(this.app, this).open();
		else if (e.altKey && (k === "c" || k === "r")) new Notice("Прогрес гравців зберігається у світі — в редакторі файлів його не змінити");
		else if (!mod && k === "tab") this.cycleChapter(e.shiftKey ? -1 : 1);
		else if (!mod && k === " ") c.fit();
		else if (!mod && (k === "-" || k === "_")) c.zoomBy(1 / 1.25);
		else if (!mod && (k === "=" || k === "+")) c.zoomBy(1.25);
		else if (!mod && k === "0") c.zoomBy(1, true);
		else if (!mod && k === "f") c.fit();
		else handled = false;
		if (handled) {
			e.preventDefault();
			e.stopPropagation();
		}
	}


	/** All quests with display labels, for pickers. */
	allQuests(): { id: string; label: string }[] {
		return this.store
			.index()
			.ofKind("quest")
			.map((q) => ({ id: q.id, label: `${this.questLabel(q.node)} — ${this.chapterTitle(q.parent)}` }));
	}
}

// ---------------------------------------------------------------------------
// Small modals
// ---------------------------------------------------------------------------

class QuestPicker extends FuzzySuggestModal<{ id: string; label: string }> {
	constructor(
		app: App,
		private readonly view: QuestGraphView,
		private readonly pick: (id: string) => void,
	) {
		super(app);
		this.setPlaceholder("Знайти квест у будь-якій главі…");
	}
	getItems() {
		return this.view.allQuests();
	}
	getItemText(i: { id: string; label: string }) {
		return i.label;
	}
	onChooseItem(i: { id: string; label: string }) {
		this.pick(i.id);
	}
}

class ItemPicker extends FuzzySuggestModal<string> {
	constructor(
		app: App,
		private readonly plugin: FtbQuestsEditorPlugin,
		private readonly pick: (id: string) => void,
	) {
		super(app);
		this.setPlaceholder("ID предмета, напр. minecraft:diamond (Enter — прийняти введене)");
		this.inputEl.addEventListener("keydown", (e) => {
			const v = this.inputEl.value.trim();
			if (e.key === "Enter" && e.shiftKey && /^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(v)) {
				this.close();
				this.pick(v);
			}
		});
	}
	getItems() {
		const ids = this.plugin.assets?.itemIds() ?? [];
		const typed = this.inputEl.value.trim();
		return typed && /^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(typed) && !ids.includes(typed) ? [typed, ...ids] : ids;
	}
	getItemText(i: string) {
		return i;
	}
	onChooseItem(i: string) {
		this.pick(i);
	}
}

class TextPrompt extends Modal {
	constructor(
		app: App,
		private readonly label: string,
		private readonly value: string,
		private readonly done: (v: string) => void,
		private readonly allowSame = false,
	) {
		super(app);
	}
	override onOpen() {
		this.titleEl.setText(this.label);
		const input = this.contentEl.createEl("input", { type: "text", cls: "ftbq-prompt" });
		input.value = this.value;
		input.focus();
		input.select();
		const ok = () => {
			this.close();
			if (input.value.trim() && (this.allowSame || input.value.trim() !== this.value)) this.done(input.value.trim());
		};
		input.addEventListener("keydown", (e) => e.key === "Enter" && ok());
		new Setting(this.contentEl).addButton((b) => b.setButtonText("OK").setCta().onClick(ok));
	}
	override onClose() {
		this.contentEl.empty();
	}
}

class ChapterModal extends Modal {
	constructor(
		app: App,
		private readonly done: (filename: string, title: string) => void,
	) {
		super(app);
	}
	override onOpen() {
		this.titleEl.setText("Нова глава");
		let filename = "";
		let title = "";
		new Setting(this.contentEl).setName("Назва").addText((t) => t.onChange((v) => (title = v)));
		new Setting(this.contentEl)
			.setName("Ім'я файлу")
			.setDesc("a-z, 0-9, _ — так буде названо chapters/<ім'я>.snbt")
			.addText((t) => t.onChange((v) => (filename = v.trim())));
		new Setting(this.contentEl).addButton((b) =>
			b.setButtonText("Створити").setCta().onClick(() => {
				if (!/^[a-z0-9_]+$/.test(filename)) return new Notice("Ім'я файлу: лише a-z, 0-9, _");
				this.close();
				this.done(filename, title.trim());
			}),
		);
	}
	override onClose() {
		this.contentEl.empty();
	}
}

class ConfirmModal extends Modal {
	constructor(
		app: App,
		private readonly question: string,
		private readonly yes: () => void,
	) {
		super(app);
	}
	override onOpen() {
		this.titleEl.setText(this.question);
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("Скасувати").onClick(() => this.close()))
			.addButton((b) =>
				b.setButtonText("Так").setWarning().onClick(() => {
					this.close();
					this.yes();
				}),
			);
	}
	override onClose() {
		this.contentEl.empty();
	}
}


// ---------------------------------------------------------------------------
// Project-level editors
// ---------------------------------------------------------------------------

/** Re-renders its content whenever the store changes (while open). */
abstract class LiveModal extends Modal {
	private off?: () => void;
	constructor(
		app: App,
		protected readonly view: QuestGraphView,
	) {
		super(app);
	}
	protected abstract render(el: HTMLElement): void;
	override onOpen() {
		this.modalEl.addClass("ftbq-modal");
		this.rerender();
		this.off = this.view.storeRef.subscribe(() => window.setTimeout(() => this.rerender(), 0));
	}
	private rerender() {
		if (this.contentEl.contains(document.activeElement) && document.activeElement?.tagName !== "BUTTON") return;
		const top = this.contentEl.scrollTop;
		this.contentEl.empty();
		this.render(this.contentEl);
		this.contentEl.scrollTop = top;
	}
	override onClose() {
		this.off?.();
		this.contentEl.empty();
	}
}

class FileSettingsModal extends LiveModal {
	protected render(el: HTMLElement) {
		this.titleEl.setText("Налаштування квестів (data.snbt)");
		const data = this.view.storeRef.files.get("data.snbt");
		if (!data || data.doc.root.kind !== "compound") {
			el.createEl("p", { text: "data.snbt не знайдено — буде створено при першій зміні." });
		}
		const root = data?.doc.root.kind === "compound" ? data.doc.root : ({ kind: "compound", entries: [] } as CompoundNode);
		renderFields(el, root, FILE_FIELDS, this.view.fieldHost("Налаштування файлу", (m, k, v) => m.setFileField(k, v)));
	}
}

class RewardTablesModal extends LiveModal {
	private selected?: string;
	protected render(el: HTMLElement) {
		this.titleEl.setText("Таблиці нагород");
		const tables = this.view.rewardTables();
		if (!this.selected || !tables.some((t) => t.id === this.selected)) this.selected = tables[0]?.id;
		new Setting(el)
			.setName("Таблиця")
			.addDropdown((d) => {
				for (const t of tables) d.addOption(t.id, t.label);
				if (this.selected) d.setValue(this.selected);
				d.onChange((v) => {
					this.selected = v;
					this.onOpenRefresh();
				});
			})
			.addButton((b) =>
				b.setButtonText("+ Нова").onClick(() =>
					new TextPrompt(this.app, "Ім'я файлу таблиці (a-z, 0-9, _)", "", (v) => {
						const id = this.view.editPublic("Нова таблиця", (m) => m.createRewardTable(v, v));
						if (id) this.selected = id;
					}).open(),
				),
			);
		const t = this.selected ? this.view.storeRef.index().get(this.selected) : undefined;
		if (!t) {
			el.createEl("p", { cls: "ftbq-muted", text: "Таблиць ще немає. Вони потрібні для нагород «випадкова», «на вибір», «уся таблиця» і «лутбокс»." });
			return;
		}
		const tid = t.id;
		const users = this.view.storeRef.index().referencesTo(tid).length;
		el.createEl("p", { cls: "ftbq-muted", text: `${t.file} · id ${tid} · використовується в ${users} нагородах` });
		const host = this.view.fieldHost("Таблиця нагород", (m, k, v) => m.putField(tid, k, v));
		const title = new Setting(el).setName("Назва").addText((tx) => {
			const v = this.view.storeRef.reader().getText("reward_table", tid, "title");
			tx.setValue(typeof v === "string" ? v : "");
			tx.inputEl.addEventListener("change", () => this.view.editPublic("Назва таблиці", (m) => m.setText("reward_table", tid, "title", tx.getValue() || undefined)));
		});
		title.settingEl.addClass("ftbq-field-row");
		renderFields(el, t.node, REWARD_TABLE_FIELDS, host);

		const rewards = getList(t.node, "rewards")?.items ?? [];
		el.createEl("h5", { text: `Нагороди (${rewards.length})` });
		rewards.forEach((r, i) => {
			if (r.kind !== "compound") return;
			const type = getString(r, "type") ?? "item";
			const def = rewardType(type);
			const box = el.createDiv("ftbq-child");
			const head = box.createDiv("ftbq-child-head");
			head.createSpan({ cls: "ftbq-badge", text: def?.label ?? type });
			const stack = getCompound(r, "item");
			head.createSpan({ cls: "ftbq-item", text: stack ? (getString(stack, "id") ?? "") : "" });
			const del = head.createEl("button", { text: "✕", cls: "ftbq-mini" });
			del.onclick = () => this.view.editPublic("Видалити з таблиці", (m) => m.removeTableReward(tid, i));
			const h2 = this.view.fieldHost("Нагорода таблиці", (m, k, v) => m.setTableRewardField(tid, i, k, v));
			renderFields(box, r, [{ key: "weight", label: "Вага", type: "float", def: 1, min: 0 }], h2);
			if (def) renderFields(box, r, def.fields.filter((f) => f.type !== "table"), h2);
		});
		new Setting(el).addButton((b) =>
			b.setButtonText("+ Нагорода").onClick((evt) => {
				const menu = new Menu();
				for (const d of REWARD_TYPES.filter((d) => !d.fields.some((f) => f.type === "table"))) {
					menu.addItem((mi) =>
						mi.setTitle(d.label).onClick(() => {
							if (d.type === "item") {
								// Table entries omit `type` for items, as FTB writes them.
								new ItemPicker(this.app, this.view.pluginRef, (item) => this.view.editPublic("Додати в таблицю", (m) => m.addTableReward(tid, { item: compound({ count: int(1), id: str(item) }) }))).open();
							} else this.view.editPublic("Додати в таблицю", (m) => m.addTableReward(tid, defaultFields(d)));
						}),
					);
				}
				menu.showAtMouseEvent(evt);
			}),
		);
		new Setting(el).addButton((b) =>
			b
				.setButtonText("Видалити таблицю")
				.setWarning()
				.onClick(() => new ConfirmModal(this.app, `Видалити таблицю? Посилань на неї: ${users}`, () => this.view.editPublic("Видалити таблицю", (m) => m.deleteRewardTable(tid))).open()),
		);
	}
	private onOpenRefresh() {
		this.contentEl.empty();
		this.render(this.contentEl);
	}
}
