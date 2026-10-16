/**
 * Canvas renderer and interaction layer for one chapter's quest graph.
 *
 * World units are FTB quest-grid units (a size-1 quest is one unit wide). The canvas knows
 * nothing about SNBT: it renders a GraphData snapshot and reports user intent to a GraphHost.
 *
 * Controls mirror the FTB Quests editor; see the events section.
 */

export interface GNode {
	id: string;
	kind: "quest" | "link";
	/** Quest links: the linked quest id. */
	target?: string;
	x: number;
	y: number;
	size: number;
	shape: string;
	label: string;
	color: string;
	optional: boolean;
	invisible: boolean;
	hasError: boolean;
	/** Item id whose texture is used as the icon, if any. */
	iconItem?: string;
	/** Dependencies on quests not visible in this chapter. */
	externalDeps: number;
}

export interface GEdge {
	/** Node ids in this chapter (a quest or a quest link). */
	from: string;
	to: string;
	/** The quest that has the dependency, and the quest it depends on. */
	questId: string;
	depId: string;
	hidden: boolean;
}

export interface GImage {
	/** Index in the chapter's `images` list. Selection id is `img:<index>`. */
	index: number;
	locked: boolean;
	x: number;
	y: number;
	w: number;
	h: number;
	rotation: number;
	label: string;
	src?: string;
}

export interface GraphData {
	nodes: GNode[];
	edges: GEdge[];
	images: GImage[];
}

export interface GraphHost {
	gridScale(): number;
	onSelect(ids: string[]): void;
	onMove(moves: { id: string; x: number; y: number }[], snap: boolean): void;
	onConnect(fromId: string, toId: string): void;
	onCreate(x: number, y: number): void;
	onContextMenu(evt: MouseEvent, target: { node?: GNode; edge?: GEdge; image?: GImage; world: { x: number; y: number } }): void;
	onEdgeSelect(edge: GEdge | undefined): void;
	/** Right Alt + LMB on a quest (FTB "copy quest"). */
	onCopy?(id: string): void;
	icon(src: string): CanvasImageSource | undefined;
}

const UNIT = 40; // pixels per world unit at zoom 1

type Drag =
	| { type: "pan"; sx: number; sy: number; ox: number; oy: number; button: number; moved: boolean }
	| { type: "move"; sx: number; sy: number; moved: boolean }
	| { type: "connect"; from: GNode; toggle: boolean }
	| { type: "box"; sx: number; sy: number; add: boolean };

export const imageId = (i: number) => `img:${i}`;

export class GraphCanvas {
	readonly canvas: HTMLCanvasElement;
	private readonly ctx: CanvasRenderingContext2D;
	private data: GraphData = { nodes: [], edges: [], images: [] };
	private byId = new Map<string, GNode>();
	private zoom = 1;
	private ox = 0; // screen offset of world origin (css px)
	private oy = 0;
	private width = 0;
	private height = 0;
	selection = new Set<string>();
	selectedEdge?: GEdge;
	private hover?: GNode;
	private drag?: Drag;
	private dragDelta = { x: 0, y: 0 };
	private mouse = { x: 0, y: 0 };
	private frame = 0;
	private readonly resize: ResizeObserver;
	private colors = readColors();
	/** Until the user pans or zooms, the view keeps re-fitting on resize. */
	private autoFit = true;
	/** Set after a right-drag pan so the following contextmenu event is swallowed. */
	private suppressContext = false;

	constructor(
		private readonly parent: HTMLElement,
		private readonly host: GraphHost,
	) {
		this.canvas = parent.createEl("canvas", { cls: "ftbq-canvas" });
		this.canvas.tabIndex = 0;
		this.ctx = this.canvas.getContext("2d")!;
		this.resize = new ResizeObserver(() => this.fitCanvas());
		this.resize.observe(parent);
		this.canvas.addEventListener("pointerdown", (e) => this.onDown(e));
		this.canvas.addEventListener("pointermove", (e) => this.onMoveEvt(e));
		this.canvas.addEventListener("pointerup", (e) => this.onUp(e));
		this.canvas.addEventListener("mousedown", (e) => e.button === 1 && e.preventDefault());
		this.canvas.addEventListener("auxclick", (e) => e.button === 1 && e.preventDefault());
		this.canvas.addEventListener("dblclick", (e) => this.onDbl(e));
		this.canvas.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
		this.canvas.addEventListener("contextmenu", (e) => this.onContext(e));
		const cancel = () => {
			if (!this.drag) return;
			this.drag = undefined;
			this.dragDelta = { x: 0, y: 0 };
			this.request();
		};
		this.canvas.addEventListener("pointercancel", cancel);
		this.canvas.addEventListener("lostpointercapture", cancel);
		this.canvas.addEventListener("pointerleave", () => {
			this.hover = undefined;
			this.request();
		});
	}

	destroy(): void {
		this.resize.disconnect();
		cancelAnimationFrame(this.frame);
		this.canvas.remove();
	}

	setData(data: GraphData): void {
		this.data = data;
		this.byId = new Map(data.nodes.map((n) => [n.id, n]));
		for (const id of [...this.selection]) if (!this.byId.has(id) && !this.imageById(id)) this.selection.delete(id);
		if (this.selectedEdge && !data.edges.some((e) => sameEdge(e, this.selectedEdge!))) this.selectedEdge = undefined;
		this.colors = readColors();
		if (this.autoFit && this.width) this.fit();
		else this.request();
	}

	setSelection(ids: string[], notify = false): void {
		this.selection = new Set(ids);
		this.selectedEdge = undefined;
		if (notify) this.host.onSelect(ids);
		this.request();
	}

	/** Fits all nodes into the view. */
	fit(): void {
		this.autoFit = true;
		const ns = this.data.nodes;
		if (!ns.length || !this.width) {
			this.zoom = 1;
			this.ox = this.width / 2;
			this.oy = this.height / 2;
			this.request();
			return;
		}
		let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
		for (const img of this.data.images) {
			const r = Math.hypot(img.w, img.h) / 2;
			const rx = Math.abs(img.rotation % 180) < 1 ? img.w / 2 : r;
			const ry = Math.abs(img.rotation % 180) < 1 ? img.h / 2 : r;
			x0 = Math.min(x0, img.x - rx);
			y0 = Math.min(y0, img.y - ry);
			x1 = Math.max(x1, img.x + rx);
			y1 = Math.max(y1, img.y + ry);
		}
		for (const n of ns) {
			x0 = Math.min(x0, n.x - n.size / 2);
			y0 = Math.min(y0, n.y - n.size / 2);
			x1 = Math.max(x1, n.x + n.size / 2);
			y1 = Math.max(y1, n.y + n.size / 2 + 0.6);
		}
		const pad = 1.5;
		this.zoom = clamp(Math.min(this.width / ((x1 - x0 + pad * 2) * UNIT), this.height / ((y1 - y0 + pad * 2) * UNIT)), 0.15, 3);
		this.ox = this.width / 2 - ((x0 + x1) / 2) * UNIT * this.zoom;
		this.oy = this.height / 2 - ((y0 + y1) / 2) * UNIT * this.zoom;
		this.request();
	}

	centerOn(id: string): void {
		const n = this.byId.get(id);
		if (!n) return;
		this.autoFit = false;
		this.ox = this.width / 2 - n.x * UNIT * this.zoom;
		this.oy = this.height / 2 - n.y * UNIT * this.zoom;
		this.request();
	}

	/** World coordinates of the view centre (for "add quest" buttons). */
	viewCenter(): { x: number; y: number } {
		return this.toWorld(this.width / 2, this.height / 2);
	}

	request(): void {
		if (this.frame) return;
		this.frame = requestAnimationFrame(() => {
			this.frame = 0;
			this.draw();
		});
	}

	// ----- coordinates -----------------------------------------------------

	private toWorld(sx: number, sy: number) {
		return { x: (sx - this.ox) / (UNIT * this.zoom), y: (sy - this.oy) / (UNIT * this.zoom) };
	}

	private toScreen(x: number, y: number) {
		return { x: this.ox + x * UNIT * this.zoom, y: this.oy + y * UNIT * this.zoom };
	}

	private local(e: MouseEvent) {
		const r = this.canvas.getBoundingClientRect();
		return { x: e.clientX - r.left, y: e.clientY - r.top };
	}

	private fitCanvas(): void {
		const r = this.parent.getBoundingClientRect();
		const first = this.width === 0;
		this.width = r.width;
		this.height = r.height;
		const dpr = window.devicePixelRatio || 1;
		this.canvas.width = Math.max(1, Math.round(r.width * dpr));
		this.canvas.height = Math.max(1, Math.round(r.height * dpr));
		this.canvas.style.width = `${r.width}px`;
		this.canvas.style.height = `${r.height}px`;
		if ((first || this.autoFit) && r.width) this.fit();
		else this.request();
	}

	// ----- hit testing -----------------------------------------------------

	private imageById(id: string): GImage | undefined {
		return id.startsWith("img:") ? this.data.images.find((i) => imageId(i.index) === id) : undefined;
	}

	/** Topmost image under the point (rotation-aware). */
	private imageAt(sx: number, sy: number): GImage | undefined {
		const w = this.toWorld(sx, sy);
		for (let i = this.data.images.length - 1; i >= 0; i--) {
			const img = this.data.images[i]!;
			const p = this.imgPos(img);
			const a = (-img.rotation * Math.PI) / 180;
			const dx = w.x - p.x;
			const dy = w.y - p.y;
			const lx = dx * Math.cos(a) - dy * Math.sin(a);
			const ly = dx * Math.sin(a) + dy * Math.cos(a);
			if (Math.abs(lx) <= img.w / 2 && Math.abs(ly) <= img.h / 2) return img;
		}
		return undefined;
	}

	private imgPos(img: GImage) {
		if ((this.drag?.type === "move" || this.moving) && this.selection.has(imageId(img.index)) && !img.locked) return { x: img.x + this.dragDelta.x, y: img.y + this.dragDelta.y };
		return { x: img.x, y: img.y };
	}

	private nodeAt(sx: number, sy: number): GNode | undefined {
		const w = this.toWorld(sx, sy);
		for (let i = this.data.nodes.length - 1; i >= 0; i--) {
			const n = this.data.nodes[i]!;
			const p = this.pos(n);
			if (Math.hypot(p.x - w.x, p.y - w.y) <= Math.max(n.size, 0.5) / 2) return n;
		}
		return undefined;
	}

	private edgeAt(sx: number, sy: number): GEdge | undefined {
		let best: GEdge | undefined;
		let bestD = 6;
		for (const e of this.data.edges) {
			const a = this.byId.get(e.from);
			const b = this.byId.get(e.to);
			if (!a || !b) continue;
			const pa = this.screenPos(a);
			const pb = this.screenPos(b);
			const d = segDist(sx, sy, pa.x, pa.y, pb.x, pb.y);
			if (d < bestD) {
				bestD = d;
				best = e;
			}
		}
		return best;
	}

	/** Node position including an in-progress drag. */
	private pos(n: GNode) {
		if ((this.drag?.type === "move" || this.moving) && this.selection.has(n.id)) return { x: n.x + this.dragDelta.x, y: n.y + this.dragDelta.y };
		return { x: n.x, y: n.y };
	}

	private screenPos(n: GNode) {
		const p = this.pos(n);
		return this.toScreen(p.x, p.y);
	}

	// ----- events ----------------------------------------------------------
	//
	// Mirrors the FTB Quests editor (QuestScreen / QuestPanel / QuestButton / ChapterImageButton):
	//   LMB quest = open (inspector) · Ctrl+LMB = toggle selection · Alt+LMB = properties
	//   Right Alt+LMB quest = copy id · MMB quest/image = select + start moving, next click places
	//   LMB drag empty = pan · MMB drag / Alt+LMB drag empty = box select (Ctrl toggles in box)
	//   wheel = scroll · Shift+wheel = horizontal · Ctrl+wheel = zoom · RMB = context menu
	// Extras kept from this editor: LMB-drag a quest = move · Ctrl+drag quest → quest = dependency
	//   · RMB drag = pan · double-click empty = new quest.

	/** "Moving" mode (FTB middle click / context "Move"): selection follows the cursor. */
	moving = false;

	startMoving(): void {
		const ids = [...this.selection].filter((id) => this.movable(id));
		if (!ids.length) return;
		this.moving = true;
		this.updateMovingDelta(false);
		this.canvas.style.cursor = "move";
		this.request();
	}

	cancelMoving(): void {
		if (!this.moving) return;
		this.moving = false;
		this.dragDelta = { x: 0, y: 0 };
		this.canvas.style.cursor = "default";
		this.request();
	}

	private movable(id: string): { x: number; y: number; size: number } | undefined {
		const n = this.byId.get(id);
		if (n) return n;
		const img = this.imageById(id);
		return img && !img.locked ? { x: img.x, y: img.y, size: 1 } : undefined;
	}

	/** FTB: the selection's top-left object lands on the snapped cursor; snap step = grid × smallest size. */
	private updateMovingDelta(noSnap: boolean): void {
		const objs = [...this.selection].flatMap((id) => this.movable(id) ?? []);
		if (!objs.length) return;
		const minX = Math.min(...objs.map((o) => o.x));
		const minY = Math.min(...objs.map((o) => o.y));
		const w = this.toWorld(this.mouse.x, this.mouse.y);
		let x = w.x;
		let y = w.y;
		if (!noSnap) {
			const step = this.host.gridScale() * Math.min(...objs.map((o) => o.size || 1));
			x = Math.round(x / step) * step;
			y = Math.round(y / step) * step;
		}
		this.dragDelta = { x: x - minX, y: y - minY };
	}

	private finishMoving(noSnap: boolean): void {
		this.updateMovingDelta(noSnap);
		this.commitDelta(false);
		this.moving = false;
		this.canvas.style.cursor = "default";
	}

	/** Sends the selection's moved positions to the host (positions are already snapped). */
	private commitDelta(snap: boolean): void {
		const moves = [...this.selection].flatMap((id) => {
			const o = this.movable(id);
			return o ? [{ id, x: o.x + this.dragDelta.x, y: o.y + this.dragDelta.y }] : [];
		});
		// Show the result immediately; the host re-renders with real data afterwards.
		for (const m of moves) {
			const n = (this.byId.get(m.id) ?? this.imageById(m.id))!;
			n.x = m.x;
			n.y = m.y;
		}
		this.dragDelta = { x: 0, y: 0 };
		if (moves.length) this.host.onMove(moves, snap);
	}

	/** Moves the selection by a fixed step (arrow keys while moving). */
	nudge(dx: number, dy: number): void {
		this.dragDelta = { x: dx, y: dy };
		this.commitDelta(false);
	}

	/** Scrolls the view by world units (arrow keys). */
	scrollBy(dx: number, dy: number): void {
		this.autoFit = false;
		this.ox -= dx * UNIT * this.zoom;
		this.oy -= dy * UNIT * this.zoom;
		this.request();
	}

	/** FTB zoom steps (`-` / `=` / `0`): multiplies around the view centre. */
	zoomBy(factor: number, reset = false): void {
		this.autoFit = false;
		const c = { x: this.width / 2, y: this.height / 2 };
		const w = this.toWorld(c.x, c.y);
		this.zoom = reset ? 1 : clamp(this.zoom * factor, 0.1, 5);
		this.ox = c.x - w.x * UNIT * this.zoom;
		this.oy = c.y - w.y * UNIT * this.zoom;
		this.request();
	}

	showGrid = true;

	/** What is under the cursor: a node id, or an image selection id. */
	hovered(): string | undefined {
		const n = this.nodeAt(this.mouse.x, this.mouse.y);
		if (n) return n.id;
		const img = this.imageAt(this.mouse.x, this.mouse.y);
		return img ? imageId(img.index) : undefined;
	}

	/** Snapped world position of the cursor (FTB paste position). */
	cursorWorld(snap = true): { x: number; y: number } {
		const w = this.toWorld(this.mouse.x, this.mouse.y);
		if (!snap) return w;
		const g = this.host.gridScale();
		return { x: Math.round(w.x / g) * g, y: Math.round(w.y / g) * g };
	}

	private toggle(id: string): void {
		if (this.selection.has(id)) this.selection.delete(id);
		else this.selection.add(id);
	}

	private notifySelection(): void {
		this.selectedEdge = undefined;
		this.host.onSelect([...this.selection]);
		this.request();
	}

	private onDown(e: PointerEvent): void {
		this.autoFit = false; // before focus(): a blur-commit must not re-fit the camera mid-click
		this.canvas.focus();
		const p = this.local(e);
		this.mouse = p;
		const mod = e.ctrlKey || e.metaKey;

		if (this.moving) {
			// FTB: any non-right click places the moving selection; right click cancels.
			if (e.button === 2) {
				this.cancelMoving();
				this.suppressContext = true;
			} else this.finishMoving(e.shiftKey);
			e.preventDefault();
			return;
		}

		const node = this.nodeAt(p.x, p.y);
		const img = node ? undefined : this.imageAt(p.x, p.y);

		if (e.button === 2) {
			// RMB press: context menu on release; dragging pans instead.
			this.drag = { type: "pan", sx: p.x, sy: p.y, ox: this.ox, oy: this.oy, button: 2, moved: false };
			this.canvas.setPointerCapture(e.pointerId);
			return;
		}

		if (e.button === 1) {
			e.preventDefault();
			const target = node?.id ?? (img && !img.locked ? imageId(img.index) : undefined);
			if (target) {
				// FTB QuestButton/ChapterImageButton: middle click = select (if needed) and move.
				if (!this.selection.has(target)) this.selection.add(target);
				this.notifySelection();
				this.startMoving();
				return;
			}
			this.drag = { type: "box", sx: p.x, sy: p.y, add: mod };
			this.canvas.setPointerCapture(e.pointerId);
			return;
		}

		if (e.button !== 0) return;
		this.canvas.setPointerCapture(e.pointerId);

		if (node) {
			if (mod) {
				// Ctrl+LMB = toggle selection; Ctrl+drag onto another quest = dependency.
				this.drag = { type: "connect", from: node, toggle: true };
				return;
			}
			if (e.getModifierState("AltGraph") || (e.altKey && this.rightAlt)) {
				this.host.onCopy?.(node.id);
				return;
			}
			if (!this.selection.has(node.id)) this.selection = new Set([node.id]);
			this.notifySelection();
			this.drag = { type: "move", sx: p.x, sy: p.y, moved: false };
			this.dragDelta = { x: 0, y: 0 };
			return;
		}

		if (img && (mod || e.altKey)) {
			// FTB: Ctrl+LMB toggles image selection, Alt+LMB opens its properties.
			const id = imageId(img.index);
			if (mod) this.toggle(id);
			else this.selection = new Set([id]);
			this.notifySelection();
			return;
		}

		const edge = this.edgeAt(p.x, p.y);
		if (edge && !mod && !e.altKey) {
			this.selection.clear();
			this.selectedEdge = edge;
			this.host.onSelect([]);
			this.host.onEdgeSelect(edge);
			this.request();
			return;
		}

		if (e.altKey) {
			// FTB: Alt + LMB drag = selection box.
			this.drag = { type: "box", sx: p.x, sy: p.y, add: mod };
			return;
		}
		this.drag = { type: "pan", sx: p.x, sy: p.y, ox: this.ox, oy: this.oy, button: 0, moved: false };
	}

	/** Tracks which Alt key is held (Right Alt + LMB = copy quest id, as in FTB). */
	private rightAlt = false;

	trackKey(e: KeyboardEvent, down: boolean): void {
		if (e.code === "AltRight") this.rightAlt = down;
	}

	private onMoveEvt(e: PointerEvent): void {
		const p = this.local(e);
		this.mouse = p;
		if (this.moving) {
			this.updateMovingDelta(e.shiftKey);
			this.request();
			return;
		}
		const d = this.drag;
		if (!d) {
			const h = this.nodeAt(p.x, p.y);
			if (h !== this.hover) {
				this.hover = h;
				this.canvas.style.cursor = h ? "pointer" : "default";
				this.request();
			}
			return;
		}
		if (d.type === "pan") {
			if (Math.hypot(p.x - d.sx, p.y - d.sy) > 3) {
				this.autoFit = false;
				d.moved = true;
			}
			this.ox = d.ox + p.x - d.sx;
			this.oy = d.oy + p.y - d.sy;
		} else if (d.type === "move") {
			const dx = (p.x - d.sx) / (UNIT * this.zoom);
			const dy = (p.y - d.sy) / (UNIT * this.zoom);
			if (!d.moved && Math.hypot(p.x - d.sx, p.y - d.sy) < 3) return;
			d.moved = true;
			if (e.altKey || e.shiftKey) this.dragDelta = { x: dx, y: dy };
			else {
				const g = this.host.gridScale();
				this.dragDelta = { x: Math.round(dx / g) * g, y: Math.round(dy / g) * g };
			}
		} else if (d.type === "connect") {
			this.hover = this.nodeAt(p.x, p.y);
		}
		this.request();
	}

	private onUp(e: PointerEvent): void {
		const d = this.drag;
		this.drag = undefined;
		if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
		if (!d) return;
		const p = this.local(e);
		if (d.type === "pan") {
			if (d.button === 2 && d.moved) this.suppressContext = true;
			// Plain LMB click on empty space clears the selection (FTB closes the viewed quest).
			if (d.button === 0 && !d.moved && (this.selection.size || this.selectedEdge)) {
				this.selection.clear();
				this.notifySelection();
				this.host.onEdgeSelect(undefined);
			}
		} else if (d.type === "move" && d.moved && (this.dragDelta.x || this.dragDelta.y)) {
			this.commitDelta(!(e.altKey || e.shiftKey));
		} else if (d.type === "move" && !d.moved) {
			// Plain click inside a multi-selection narrows it to the clicked quest (FTB: opens it).
			const n = this.nodeAt(p.x, p.y);
			if (n && this.selection.size > 1) {
				this.selection = new Set([n.id]);
				this.notifySelection();
			}
		} else if (d.type === "connect") {
			const target = this.nodeAt(p.x, p.y);
			if (target && target.id !== d.from.id) this.host.onConnect(d.from.id, target.id);
			else if (target?.id === d.from.id) {
				this.toggle(d.from.id);
				this.notifySelection();
			}
		} else if (d.type === "box") {
			// FTB selectAllQuestsInBox: without Ctrl the selection is replaced; objects in the box are toggled.
			if (!d.add) this.selection.clear();
			const a = this.toWorld(Math.min(d.sx, p.x), Math.min(d.sy, p.y));
			const b = this.toWorld(Math.max(d.sx, p.x), Math.max(d.sy, p.y));
			const inBox = (x: number, y: number) => x >= a.x && x <= b.x && y >= a.y && y <= b.y;
			for (const n of this.data.nodes) if (inBox(n.x, n.y)) this.toggle(n.id);
			for (const img of this.data.images) if (inBox(img.x, img.y)) this.toggle(imageId(img.index));
			this.notifySelection();
		}
		this.dragDelta = { x: 0, y: 0 };
		this.request();
	}

	private onDbl(e: MouseEvent): void {
		if (e.button !== 0 || this.moving) return;
		const p = this.local(e);
		if (this.nodeAt(p.x, p.y)) return;
		const w = this.toWorld(p.x, p.y);
		this.host.onCreate(w.x, w.y);
	}

	/** FTB (new scroll behaviour): wheel scrolls, Shift+wheel scrolls sideways, Ctrl+wheel zooms. */
	private onWheel(e: WheelEvent): void {
		e.preventDefault();
		this.autoFit = false;
		const k = e.deltaMode === 1 ? 20 : 1;
		if (e.ctrlKey || e.metaKey) {
			const p = this.local(e);
			const w = this.toWorld(p.x, p.y);
			this.zoom = clamp(this.zoom * Math.exp(-e.deltaY * k * 0.0015), 0.1, 5);
			this.ox = p.x - w.x * UNIT * this.zoom;
			this.oy = p.y - w.y * UNIT * this.zoom;
		} else if (e.shiftKey) {
			this.ox -= (e.deltaY || e.deltaX) * k;
		} else {
			this.ox -= e.deltaX * k;
			this.oy -= e.deltaY * k;
		}
		if (this.moving) this.updateMovingDelta(e.shiftKey);
		this.request();
	}

	private onContext(e: MouseEvent): void {
		e.preventDefault();
		if (this.suppressContext) {
			this.suppressContext = false;
			return;
		}
		const p = this.local(e);
		const node = this.nodeAt(p.x, p.y);
		const edge = node ? undefined : this.edgeAt(p.x, p.y);
		const image = node || edge ? undefined : this.imageAt(p.x, p.y);
		this.host.onContextMenu(e, { node, edge, image, world: this.toWorld(p.x, p.y) });
		this.request();
	}

	// ----- drawing ---------------------------------------------------------

	private draw(): void {
		const { ctx } = this;
		const dpr = window.devicePixelRatio || 1;
		const c = this.colors;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.fillStyle = c.bg;
		ctx.fillRect(0, 0, this.width, this.height);
		if (this.showGrid) this.drawGrid();

		const s = UNIT * this.zoom;
		for (const img of this.data.images) this.drawImage(img, s);

		// edges
		for (const e of this.data.edges) {
			const a = this.byId.get(e.from);
			const b = this.byId.get(e.to);
			if (!a || !b) continue;
			const selected = this.selectedEdge && sameEdge(e, this.selectedEdge);
			const related = this.selection.has(e.from) || this.selection.has(e.to);
			this.drawEdge(a, b, selected ? c.accent : related ? c.text : c.edge, selected ? 3 : related ? 2 : 1.4, e.hidden);
		}
		if (this.drag?.type === "connect") {
			const a = this.screenPos(this.drag.from);
			ctx.strokeStyle = c.accent;
			ctx.lineWidth = 2;
			ctx.setLineDash([6, 4]);
			ctx.beginPath();
			ctx.moveTo(a.x, a.y);
			ctx.lineTo(this.mouse.x, this.mouse.y);
			ctx.stroke();
			ctx.setLineDash([]);
		}

		// nodes
		for (const n of this.data.nodes) this.drawNode(n, s);

		// box selection
		if (this.drag?.type === "box") {
			const d = this.drag;
			ctx.strokeStyle = c.accent;
			ctx.fillStyle = withAlpha(c.accent, 0.12);
			const x = Math.min(d.sx, this.mouse.x);
			const y = Math.min(d.sy, this.mouse.y);
			ctx.fillRect(x, y, Math.abs(this.mouse.x - d.sx), Math.abs(this.mouse.y - d.sy));
			ctx.strokeRect(x, y, Math.abs(this.mouse.x - d.sx), Math.abs(this.mouse.y - d.sy));
		}

	}

	private drawGrid(): void {
		const { ctx } = this;
		const g = this.host.gridScale();
		let step = g * UNIT * this.zoom;
		while (step < 12) step *= 2;
		ctx.fillStyle = this.colors.grid;
		const x0 = ((this.ox % step) + step) % step;
		const y0 = ((this.oy % step) + step) % step;
		for (let x = x0; x < this.width; x += step) for (let y = y0; y < this.height; y += step) ctx.fillRect(x - 0.75, y - 0.75, 1.5, 1.5);
		// origin cross
		ctx.strokeStyle = this.colors.grid;
		ctx.beginPath();
		ctx.moveTo(this.ox - 8, this.oy);
		ctx.lineTo(this.ox + 8, this.oy);
		ctx.moveTo(this.ox, this.oy - 8);
		ctx.lineTo(this.ox, this.oy + 8);
		ctx.stroke();
	}

	private drawImage(img: GImage, s: number): void {
		const { ctx } = this;
		const wp = this.imgPos(img);
		const p = this.toScreen(wp.x, wp.y);
		ctx.save();
		ctx.translate(p.x, p.y);
		ctx.rotate((img.rotation * Math.PI) / 180);
		const w = img.w * s;
		const h = img.h * s;
		const tex = img.src ? this.host.icon(img.src) : undefined;
		if (tex) {
			ctx.imageSmoothingEnabled = false;
			ctx.globalAlpha = 0.9;
			ctx.drawImage(tex, -w / 2, -h / 2, w, h);
		} else {
			ctx.strokeStyle = this.colors.border;
			ctx.setLineDash([4, 4]);
			ctx.strokeRect(-w / 2, -h / 2, w, h);
			ctx.setLineDash([]);
			if (this.zoom > 0.4) {
				ctx.fillStyle = this.colors.muted;
				ctx.font = "11px var(--font-interface, sans-serif)";
				ctx.textAlign = "center";
				ctx.textBaseline = "middle";
				ctx.fillText(img.label, 0, 0, w - 8);
			}
		}
		if (this.selection.has(imageId(img.index))) {
			ctx.strokeStyle = this.colors.accent;
			ctx.lineWidth = 2;
			ctx.setLineDash(img.locked ? [3, 3] : []);
			ctx.strokeRect(-w / 2 - 2, -h / 2 - 2, w + 4, h + 4);
			ctx.setLineDash([]);
		}
		ctx.restore();
	}

	private drawEdge(a: GNode, b: GNode, color: string, width: number, hidden: boolean): void {
		const { ctx } = this;
		const pa = this.screenPos(a);
		const pb = this.screenPos(b);
		const dx = pb.x - pa.x;
		const dy = pb.y - pa.y;
		const len = Math.hypot(dx, dy);
		if (len < 1) return;
		const ux = dx / len;
		const uy = dy / len;
		const s = UNIT * this.zoom;
		const ra = (a.size * s) / 2;
		const rb = (b.size * s) / 2 + 3;
		if (len <= ra + rb) return;
		const sx = pa.x + ux * ra;
		const sy = pa.y + uy * ra;
		const ex = pb.x - ux * rb;
		const ey = pb.y - uy * rb;
		ctx.strokeStyle = color;
		ctx.fillStyle = color;
		ctx.lineWidth = width;
		if (hidden) ctx.setLineDash([3, 5]);
		ctx.beginPath();
		ctx.moveTo(sx, sy);
		ctx.lineTo(ex, ey);
		ctx.stroke();
		ctx.setLineDash([]);
		const ah = clamp(6 * this.zoom + 3, 5, 12);
		ctx.beginPath();
		ctx.moveTo(ex, ey);
		ctx.lineTo(ex - ux * ah - uy * ah * 0.55, ey - uy * ah + ux * ah * 0.55);
		ctx.lineTo(ex - ux * ah + uy * ah * 0.55, ey - uy * ah - ux * ah * 0.55);
		ctx.closePath();
		ctx.fill();
	}

	private drawNode(n: GNode, s: number): void {
		const { ctx } = this;
		const c = this.colors;
		const p = this.screenPos(n);
		const r = (Math.max(n.size, 0.3) * s) / 2;
		if (p.x < -r * 3 || p.y < -r * 3 || p.x > this.width + r * 3 || p.y > this.height + r * 3) return;
		const selected = this.selection.has(n.id);
		const connectTarget = this.drag?.type === "connect" && this.hover === n;

		ctx.globalAlpha = n.invisible ? 0.45 : 1;
		shapePath(ctx, n.shape, p.x, p.y, r);
		ctx.fillStyle = n.kind === "link" ? c.bgSecondary : withAlpha(n.color, 0.22);
		ctx.fill();
		ctx.lineWidth = selected || connectTarget ? 3 : 1.6;
		ctx.strokeStyle = selected || connectTarget ? c.accent : n.hasError ? c.error : n.color;
		if (n.optional || n.kind === "link") ctx.setLineDash([4, 3]);
		ctx.stroke();
		ctx.setLineDash([]);

		const tex = n.iconItem ? this.host.icon(n.iconItem) : undefined;
		if (tex) {
			const is = r * 1.15;
			ctx.imageSmoothingEnabled = false;
			ctx.drawImage(tex, p.x - is / 2, p.y - is / 2, is, is);
		} else if (r > 6) {
			ctx.fillStyle = n.color;
			ctx.font = `600 ${Math.round(r * 0.8)}px var(--font-interface, sans-serif)`;
			ctx.textAlign = "center";
			ctx.textBaseline = "middle";
			ctx.fillText(initials(n.label), p.x, p.y + 1);
		}
		if (n.kind === "link") {
			ctx.fillStyle = c.muted;
			ctx.font = `${Math.max(9, Math.round(r * 0.5))}px var(--font-interface, sans-serif)`;
			ctx.fillText("↗", p.x + r * 0.75, p.y - r * 0.75);
		}
		if (n.externalDeps > 0 && r > 5) {
			ctx.fillStyle = c.muted;
			ctx.font = `${Math.max(9, Math.round(r * 0.45))}px var(--font-interface, sans-serif)`;
			ctx.textAlign = "right";
			ctx.fillText(`⤶${n.externalDeps}`, p.x - r * 0.6, p.y - r * 0.85);
		}
		ctx.globalAlpha = 1;

		const showLabel = selected || this.hover === n || s >= 60;
		if (showLabel && n.label) {
			ctx.font = `${clamp(Math.round(10 * Math.sqrt(this.zoom)), 10, 13)}px var(--font-interface, sans-serif)`;
			ctx.textAlign = "center";
			ctx.textBaseline = "top";
			const max = selected || this.hover === n ? 240 : Math.max(50, s * 1.9);
			const text = truncate(ctx, n.label, max);
			const tw = ctx.measureText(text).width;
			ctx.fillStyle = withAlpha(c.bgRgb, 0.75);
			ctx.fillRect(p.x - tw / 2 - 2, p.y + r + 3, tw + 4, 14);
			ctx.fillStyle = selected ? c.text : c.muted;
			ctx.fillText(text, p.x, p.y + r + 4);
		}
	}
}

// ---------------------------------------------------------------------------

export function shapePath(ctx: CanvasRenderingContext2D, shape: string, x: number, y: number, r: number): void {
	ctx.beginPath();
	const poly = (n: number, rot: number, rr = r) => {
		for (let i = 0; i < n; i++) {
			const a = rot + (i * 2 * Math.PI) / n;
			const px = x + Math.cos(a) * rr;
			const py = y + Math.sin(a) * rr;
			if (i === 0) ctx.moveTo(px, py);
			else ctx.lineTo(px, py);
		}
		ctx.closePath();
	};
	switch (shape) {
		case "square":
			ctx.rect(x - r, y - r, r * 2, r * 2);
			break;
		case "rsquare":
			roundRect(ctx, x - r, y - r, r * 2, r * 2, r * 0.35);
			break;
		case "diamond":
			poly(4, -Math.PI / 2, r * 1.1);
			break;
		case "pentagon":
			poly(5, -Math.PI / 2);
			break;
		case "hexagon":
			poly(6, 0);
			break;
		case "octagon":
			poly(8, Math.PI / 8);
			break;
		case "heart": {
			const t = y - r * 0.35;
			ctx.moveTo(x, y + r);
			ctx.bezierCurveTo(x - r * 1.4, y + r * 0.1, x - r * 0.9, t - r * 0.9, x, t);
			ctx.bezierCurveTo(x + r * 0.9, t - r * 0.9, x + r * 1.4, y + r * 0.1, x, y + r);
			ctx.closePath();
			break;
		}
		case "gear": {
			const teeth = 8;
			for (let i = 0; i < teeth * 2; i++) {
				const a = (i * Math.PI) / teeth;
				const rr = i % 2 === 0 ? r : r * 0.78;
				const a0 = a - Math.PI / teeth / 2;
				const a1 = a + Math.PI / teeth / 2;
				if (i === 0) ctx.moveTo(x + Math.cos(a0) * rr, y + Math.sin(a0) * rr);
				else ctx.lineTo(x + Math.cos(a0) * rr, y + Math.sin(a0) * rr);
				ctx.lineTo(x + Math.cos(a1) * rr, y + Math.sin(a1) * rr);
			}
			ctx.closePath();
			break;
		}
		case "none":
			ctx.arc(x, y, r * 0.6, 0, Math.PI * 2);
			break;
		default:
			ctx.arc(x, y, r, 0, Math.PI * 2);
	}
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
	ctx.beginPath();
	ctx.moveTo(x + r, y);
	ctx.arcTo(x + w, y, x + w, y + h, r);
	ctx.arcTo(x + w, y + h, x, y + h, r);
	ctx.arcTo(x, y + h, x, y, r);
	ctx.arcTo(x, y, x + w, y, r);
	ctx.closePath();
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
	const dx = bx - ax;
	const dy = by - ay;
	const l2 = dx * dx + dy * dy;
	const t = l2 ? clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1) : 0;
	return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function sameEdge(a: GEdge, b: GEdge): boolean {
	return a.questId === b.questId && a.depId === b.depId && a.from === b.from && a.to === b.to;
}

function clamp(v: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, v));
}

function initials(label: string): string {
	const words = label.replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/).filter(Boolean);
	if (!words.length) return "?";
	return (words.length > 1 ? words[0]![0]! + words[1]![0]! : words[0]!.slice(0, 2)).toUpperCase();
}

function truncate(ctx: CanvasRenderingContext2D, text: string, max: number): string {
	if (ctx.measureText(text).width <= max) return text;
	let lo = 0;
	let hi = text.length;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (ctx.measureText(text.slice(0, mid) + "…").width <= max) lo = mid;
		else hi = mid - 1;
	}
	return text.slice(0, lo) + "…";
}

export function withAlpha(color: string, alpha: number): string {
	const m = /^#([0-9a-f]{6})$/i.exec(color.trim());
	if (m) {
		const v = parseInt(m[1]!, 16);
		return `rgba(${v >> 16}, ${(v >> 8) & 255}, ${v & 255}, ${alpha})`;
	}
	const rgb = /^rgba?\(([^)]+)\)$/.exec(color.trim());
	if (rgb) {
		const [r, g, b] = rgb[1]!.split(",").map((s) => s.trim());
		return `rgba(${r}, ${g}, ${b}, ${alpha})`;
	}
	return color;
}

function readColors() {
	const st = getComputedStyle(document.body);
	const v = (name: string, fallback: string) => st.getPropertyValue(name).trim() || fallback;
	return {
		bg: v("--background-primary", "#1e1e1e"),
		bgRgb: toRgb(v("--background-primary", "#1e1e1e")),
		bgSecondary: v("--background-secondary", "#262626"),
		tooltipBg: v("--background-secondary-alt", "#2a2a2a"),
		text: v("--text-normal", "#dcddde"),
		muted: v("--text-muted", "#999"),
		accent: toRgb(v("--interactive-accent", "#7f6df2")),
		border: v("--background-modifier-border", "#444"),
		grid: v("--background-modifier-border", "#333"),
		edge: v("--text-faint", "#666"),
		error: v("--text-error", "#e5534b"),
	};
}

/** Resolves any CSS colour (hsl, named, ...) to rgb() so alpha can be applied. */
function toRgb(color: string): string {
	const c = document.createElement("canvas").getContext("2d")!;
	c.fillStyle = color;
	return c.fillStyle; // normalised to #rrggbb or rgba()
}
