/**
 * Schema-driven property editors: renders one Obsidian `Setting` per field of a FieldDef list
 * and turns user input into typed SNBT nodes (or removals, for default values).
 */

import { Setting } from "obsidian";
import { fieldNode, intArray, isDefault, type FieldDef } from "../engine/schema";
import { idOf } from "../engine/questModel";
import { bool, cloneNode, compound, get, getCompound, getString, int, list, long, set, str, stringItems, type CompoundNode, type SnbtNode } from "../engine/snbtNodes";

export type Changes = Record<string, SnbtNode | undefined>;

export interface FieldHost {
	commit(changes: Changes): void;
	pickItem(done: (id: string) => void): void;
	pickQuest(done: (id: string) => void): void;
	questLabel(id: string): string;
	rewardTables(): { id: string; label: string }[];
}

const TRI_LABELS: Record<string, string> = { "": "(за замовчуванням)", true: "так", false: "ні" };

/** Raw scalar of a node for display. */
function scalar(n: SnbtNode | undefined): string | number | boolean | undefined {
	if (!n) return undefined;
	if (n.kind === "string") return n.value;
	if (n.kind === "number") return Number(n.text);
	if (n.kind === "bool") return n.value;
	return undefined;
}

/** Signed decimal long for a 16-hex-digit id (how FTB stores `table_id`). */
export function hexToLong(hex: string): string {
	return BigInt.asIntN(64, BigInt("0x" + hex)).toString();
}

export function renderFields(el: HTMLElement, node: CompoundNode, fields: FieldDef[], host: FieldHost): void {
	for (const f of fields) renderField(el, node, f, host);
}

function renderField(el: HTMLElement, node: CompoundNode, f: FieldDef, host: FieldHost): void {
	const s = new Setting(el).setName(f.label);
	s.settingEl.addClass("ftbq-field-row");
	if (f.desc) s.setDesc(f.desc);
	const cur = get(node, f.key);
	const value = scalar(cur);
	const put = (v: string | number | boolean | undefined) => {
		const changes: Changes = { [f.key]: v === undefined || isDefault(f, v) ? undefined : fieldNode(f, v) };
		// Observation tasks: FTB reads the `observe_type` ordinal before the name.
		if (f.key === "observation_type" && get(node, "observe_type") && typeof v === "string") changes.observe_type = int(Math.max(0, f.options!.indexOf(v)));
		host.commit(changes);
	};

	switch (f.type) {
		case "bool":
			s.addToggle((t) => t.setValue(Boolean(value ?? f.def ?? false)).onChange((v) => put(v)));
			break;
		case "tristate":
			s.addDropdown((d) => {
				for (const k of ["", "true", "false"]) d.addOption(k, TRI_LABELS[k]!);
				d.setValue(value === undefined ? "" : String(value));
				d.onChange((v) => host.commit({ [f.key]: v === "" ? undefined : bool(v === "true") }));
			});
			break;
		case "enum":
		case "int_enum":
			s.addDropdown((d) => {
				for (const o of f.options ?? []) d.addOption(o, o || "(порожньо)");
				const v = String(value ?? f.def ?? "");
				if (!(f.options ?? []).includes(v)) d.addOption(v, v);
				d.setValue(v);
				d.onChange((v2) => put(v2));
			});
			break;
		case "int":
		case "long":
		case "double":
		case "float": {
			const input = s.controlEl.createEl("input", { type: "number", cls: "ftbq-num" });
			input.value = value === undefined ? String(f.def ?? "") : String(value);
			if (f.min !== undefined) input.min = String(f.min);
			if (f.type === "double" || f.type === "float") input.step = "any";
			input.addEventListener("change", () => {
				if (input.value.trim() === "") return put(undefined);
				let v = Number(input.value);
				if (!Number.isFinite(v)) return;
				if (f.min !== undefined) v = Math.max(f.min, v);
				put(v);
			});
			break;
		}
		case "string":
		case "text": {
			const input = f.type === "text" ? s.controlEl.createEl("textarea") : s.controlEl.createEl("input", { type: "text" });
			input.value = typeof value === "string" ? value : "";
			if (f.hint) input.placeholder = `${f.hint} id, напр. ${f.def ?? ""}`;
			input.addEventListener("change", () => put(input.value));
			if (f.type === "string") input.addEventListener("keydown", (e) => (e as KeyboardEvent).key === "Enter" && input.blur());
			break;
		}
		case "tags": {
			const input = s.controlEl.createEl("input", { type: "text", placeholder: "через кому" });
			input.value = cur?.kind === "list" ? stringItems(cur).join(", ") : "";
			input.addEventListener("change", () => {
				const tags = input.value.split(",").map((t) => t.trim()).filter(Boolean);
				host.commit({ [f.key]: tags.length ? list(tags.map(str), true) : undefined });
			});
			break;
		}
		case "item":
		case "icon": {
			const stack = cur?.kind === "compound" ? cur : undefined;
			const id = stack ? getString(stack, "id") : cur?.kind === "string" ? cur.value : undefined;
			s.setDesc(id ?? (f.type === "icon" ? "(автоматично)" : "—"));
			s.addButton((b) =>
				b.setButtonText(id ? "Змінити" : "Обрати").onClick(() =>
					host.pickItem((newId) => {
						// Only the id changes: components (names, enchantments, filters) are kept.
						const copy = stack ? cloneNode(stack) : compound(f.type === "item" ? { count: int(1), id: str(newId) } : { id: str(newId) }, f.type === "item");
						set(copy, "id", str(newId));
						host.commit({ [f.key]: copy });
					}),
				),
			);
			if (f.type === "icon" && cur) s.addExtraButton((b) => b.setIcon("x").setTooltip("Прибрати").onClick(() => host.commit({ [f.key]: undefined })));
			break;
		}
		case "fluid": {
			const stack = getCompound(node, f.key);
			const input = s.controlEl.createEl("input", { type: "text", placeholder: "minecraft:water" });
			input.value = stack ? (getString(stack, "id") ?? "") : "";
			input.addEventListener("change", () => {
				const copy = stack ? cloneNode(stack) : compound({ amount: int(1000) }, true);
				set(copy, "id", str(input.value.trim()));
				host.commit({ [f.key]: copy });
			});
			break;
		}
		case "int3": {
			const arr = cur?.kind === "array" ? cur.items.map((i) => Number(i.text)) : [0, 0, 0];
			const inputs = [0, 1, 2].map((i) => {
				const inp = s.controlEl.createEl("input", { type: "number", cls: "ftbq-num ftbq-num-sm" });
				inp.value = String(arr[i] ?? 0);
				return inp;
			});
			for (const inp of inputs) inp.addEventListener("change", () => host.commit({ [f.key]: intArray(inputs.map((x) => Number(x.value) || 0)) }));
			break;
		}
		case "quest": {
			const id = typeof value === "string" ? value : "";
			s.setDesc(id ? host.questLabel(id) : "—");
			s.addButton((b) => b.setButtonText(id ? "Змінити" : "Обрати").onClick(() => host.pickQuest((q) => host.commit({ [f.key]: str(q) }))));
			if (id) s.addExtraButton((b) => b.setIcon("x").setTooltip("Прибрати").onClick(() => host.commit({ [f.key]: f.always ? str("") : undefined })));
			break;
		}
		case "table": {
			const current = idOf(cur) ?? "";
			s.addDropdown((d) => {
				d.addOption("", "— оберіть —");
				for (const t of host.rewardTables()) d.addOption(t.id, t.label);
				if (current && !host.rewardTables().some((t) => t.id === current)) d.addOption(current, `⚠ ${current}`);
				d.setValue(current);
				d.onChange((v) => host.commit({ [f.key]: v ? long(hexToLong(v)) : undefined }));
			});
			break;
		}
	}
}
