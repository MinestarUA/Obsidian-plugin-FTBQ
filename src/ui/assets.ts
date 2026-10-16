/**
 * Item / texture icons read straight from mod jars and the Minecraft client jar.
 *
 * Jars are zip files; only their central directories are read up front (names + offsets),
 * single entries are inflated on demand. Item models are followed through `parent` chains to
 * find a flat texture (layer0 for items, a face texture for blocks). Builtin/entity models
 * (chests, shields, ...) have no flat texture and fall back to the canvas initials.
 */

import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";

interface ZipEntry {
	file: string;
	method: number;
	compSize: number;
	headerOffset: number;
}

const FACE_KEYS = ["layer0", "all", "front", "side", "texture", "top", "end", "cross", "plant", "north", "particle"];

export class AssetLibrary {
	private readonly entries = new Map<string, ZipEntry>();
	private readonly bitmaps = new Map<string, ImageBitmap | null>();
	private readonly pending = new Map<string, Promise<void>>();
	private indexed = false;

	/** @param sources jar files or directories of jars; the first source providing a path wins. */
	constructor(
		private readonly sources: string[],
		private readonly onLoaded: () => void,
	) {}

	private ensureIndex(): void {
		if (this.indexed) return;
		this.indexed = true;
		for (const src of this.sources) {
			if (!src || !existsSync(src)) continue;
			const jars = statSync(src).isDirectory()
				? readdirSync(src)
						.filter((f) => f.endsWith(".jar"))
						.sort()
						.map((f) => join(src, f))
				: [src];
			for (const jar of jars) {
				try {
					for (const e of readCentralDirectory(jar)) {
						// Keep the first occurrence per path (vanilla first, mods override only new paths).
						if (!this.entries.has(e.name)) this.entries.set(e.name, e.entry);
					}
				} catch (err) {
					console.warn(`[ftbquests-editor] cannot index ${jar}`, err);
				}
			}
		}
	}

	/** Releases decoded bitmaps. */
	dispose(): void {
		for (const b of this.bitmaps.values()) b?.close();
		this.bitmaps.clear();
	}

	get size(): number {
		this.ensureIndex();
		return this.entries.size;
	}

	/** All item ids that have an item model, e.g. for an item picker. */
	itemIds(): string[] {
		this.ensureIndex();
		const ids: string[] = [];
		for (const name of this.entries.keys()) {
			const m = /^assets\/([^/]+)\/models\/item\/(.+)\.json$/.exec(name);
			if (m) ids.push(`${m[1]}:${m[2]}`);
		}
		return ids.sort();
	}

	/**
	 * Returns a cached bitmap for an icon reference, or undefined while loading / if missing.
	 * References: "ns:item_id" (item), "tex:ns:path" (texture without textures/ and .png),
	 * "ns:textures/....png" (full texture path, e.g. chapter images).
	 */
	get(ref: string): ImageBitmap | undefined {
		const cached = this.bitmaps.get(ref);
		if (cached !== undefined) return cached ?? undefined;
		if (!this.pending.has(ref)) {
			this.pending.set(
				ref,
				this.load(ref)
					.then((bmp) => {
						this.bitmaps.set(ref, bmp);
						if (bmp) this.onLoaded();
					})
					.catch(() => {
						this.bitmaps.set(ref, null);
					})
					.finally(() => this.pending.delete(ref)),
			);
		}
		return undefined;
	}

	private async load(ref: string): Promise<ImageBitmap | null> {
		this.ensureIndex();
		const path = this.texturePath(ref);
		if (!path) return null;
		const png = this.read(path);
		if (!png) return null;
		const blob = new Blob([new Uint8Array(png)], { type: "image/png" });
		const full = await createImageBitmap(blob);
		// Animated textures are vertical strips: use the first frame.
		if (full.height > full.width && full.height % full.width === 0 && this.entries.has(`${path}.mcmeta`)) {
			const frame = await createImageBitmap(full, 0, 0, full.width, full.width);
			full.close();
			return frame;
		}
		return full;
	}

	private texturePath(ref: string): string | undefined {
		if (ref.startsWith("tex:")) return textureFile(ref.slice(4));
		if (/\.png$/.test(ref)) {
			const [ns, p] = splitId(ref);
			return `assets/${ns}/${p}`;
		}
		const [ns, name] = splitId(ref);
		const tex = this.modelTexture(`${ns}:item/${name}`, 0);
		if (tex) return textureFile(tex);
		for (const p of [`assets/${ns}/textures/item/${name}.png`, `assets/${ns}/textures/block/${name}.png`]) if (this.entries.has(p)) return p;
		return undefined;
	}

	/** Follows a model's parent chain and returns its best flat texture reference. */
	private modelTexture(modelRef: string, depth: number, textures: Record<string, string> = {}): string | undefined {
		if (depth > 8) return undefined;
		const [ns, p] = splitId(modelRef);
		const raw = this.read(`assets/${ns}/models/${p}.json`);
		if (!raw) return undefined;
		let model: { parent?: string; textures?: Record<string, string> };
		try {
			model = JSON.parse(new TextDecoder().decode(raw));
		} catch {
			return undefined;
		}
		const merged = { ...(model.textures ?? {}), ...textures }; // child textures win
		const resolve = (v: string | undefined, n = 0): string | undefined => (v?.startsWith("#") && n < 8 ? resolve(merged[v.slice(1)], n + 1) : v);
		for (const k of FACE_KEYS) {
			const v = resolve(merged[k]);
			if (v && !v.startsWith("#") && (k !== "particle" || !model.parent)) return v;
		}
		if (model.parent && !model.parent.startsWith("builtin/")) return this.modelTexture(model.parent.includes(":") ? model.parent : `minecraft:${model.parent}`, depth + 1, merged);
		return resolve(merged.particle);
	}

	private read(path: string): Uint8Array | undefined {
		const e = this.entries.get(path);
		return e ? readEntry(e) : undefined;
	}
}

function splitId(id: string): [string, string] {
	const i = id.indexOf(":");
	return i < 0 ? ["minecraft", id] : [id.slice(0, i), id.slice(i + 1)];
}

function textureFile(tex: string): string {
	const [ns, p] = splitId(tex);
	return `assets/${ns}/textures/${p}.png`;
}

// ---------------------------------------------------------------------------
// Minimal zip reader (central directory + stored/deflated entries)
// ---------------------------------------------------------------------------

function readCentralDirectory(file: string): { name: string; entry: ZipEntry }[] {
	const fd = openSync(file, "r");
	try {
		const size = statSync(file).size;
		const tailLen = Math.min(size, 65557);
		const tail = Buffer.alloc(tailLen);
		readSync(fd, tail, 0, tailLen, size - tailLen);
		let eocd = -1;
		for (let i = tailLen - 22; i >= 0; i--) {
			if (tail.readUInt32LE(i) === 0x06054b50) {
				eocd = i;
				break;
			}
		}
		if (eocd < 0) throw new Error("not a zip file");
		const count = tail.readUInt16LE(eocd + 10);
		if (count === 0xffff || tail.readUInt32LE(eocd + 16) === 0xffffffff) throw new Error("ZIP64 jars are not supported");
		const cdSize = tail.readUInt32LE(eocd + 12);
		const cdOffset = tail.readUInt32LE(eocd + 16);
		const cd = Buffer.alloc(cdSize);
		readSync(fd, cd, 0, cdSize, cdOffset);
		const out: { name: string; entry: ZipEntry }[] = [];
		let p = 0;
		for (let i = 0; i < count && p + 46 <= cd.length; i++) {
			if (cd.readUInt32LE(p) !== 0x02014b50) break;
			const method = cd.readUInt16LE(p + 10);
			const compSize = cd.readUInt32LE(p + 20);
			const nameLen = cd.readUInt16LE(p + 28);
			const extraLen = cd.readUInt16LE(p + 30);
			const commentLen = cd.readUInt16LE(p + 32);
			const headerOffset = cd.readUInt32LE(p + 42);
			const name = cd.toString("utf8", p + 46, p + 46 + nameLen);
			if (name.startsWith("assets/") && (name.endsWith(".png") || name.endsWith(".json") || name.endsWith(".png.mcmeta")) && (name.includes("/textures/") || name.includes("/models/"))) {
				out.push({ name, entry: { file, method, compSize, headerOffset } });
			}
			p += 46 + nameLen + extraLen + commentLen;
		}
		return out;
	} finally {
		closeSync(fd);
	}
}

function readEntry(e: ZipEntry): Uint8Array | undefined {
	const fd = openSync(e.file, "r");
	try {
		const header = Buffer.alloc(30);
		readSync(fd, header, 0, 30, e.headerOffset);
		if (header.readUInt32LE(0) !== 0x04034b50) return undefined;
		const start = e.headerOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
		const data = Buffer.alloc(e.compSize);
		readSync(fd, data, 0, e.compSize, start);
		if (e.method === 0) return data;
		if (e.method === 8) return inflateRawSync(data);
		return undefined;
	} finally {
		closeSync(fd);
	}
}
