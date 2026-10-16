/**
 * Field schema of every FTB Quests object, taken from the `writeData` / `readData` methods of
 * FTB Quests 2101.1.x (NeoForge 1.21.1). The UI renders editors from these descriptors, and the
 * `defaultFields` builders create new tasks / rewards the way FTB itself would write them.
 *
 * Unknown fields are never touched: the editor only reads and writes the keys listed here.
 */

import { t as tr } from "../i18n";
import { bool, compound, double, int, long, num, str, type ArrayNode, type CompoundNode, type SnbtNode } from "./snbtNodes";

export type FieldType =
	| "string"
	| "text" // multi-line string
	| "bool"
	| "tristate" // absent = default, true / false otherwise
	| "int"
	| "long"
	| "double"
	| "float"
	| "enum"
	| "int_enum"
	| "item" // item stack compound
	| "icon" // optional item stack compound
	| "fluid" // fluid stack compound
	| "int3" // [I; x, y, z]
	| "quest" // quest id reference
	| "table" // reward table id (long)
	| "tags"; // list of strings

export interface FieldDef {
	key: string;
	label: string;
	type: FieldType;
	/** Value FTB assumes when the key is absent. Equal values are removed (unless `always`). */
	def?: string | number | boolean;
	/** FTB writes the key even when it has the default value. */
	always?: boolean;
	options?: readonly string[];
	/** Hint for id-like strings, e.g. "entity" → suggestions / placeholder. */
	hint?: string;
	desc?: string;
	min?: number;
}

export interface TypeDef {
	type: string;
	label: string;
	fields: FieldDef[];
	/** Extra fields a freshly created object starts with. */
	init?: () => Record<string, SnbtNode>;
}

const TRI = "tristate" as const;

// ----- quest objects (shared) ------------------------------------------------

const OBJECT_COMMON: FieldDef[] = [
	{ key: "icon", label: tr("Icon"), type: "icon" },
	{ key: "disable_toast", label: tr("No toast"), type: "bool", def: false },
	{ key: "tags", label: tr("Tags"), type: "tags" },
	{ key: "custom_id", label: "Custom id", type: "string", def: "" },
];

// ----- tasks -------------------------------------------------------------------

export const TASK_COMMON: FieldDef[] = [{ key: "optional_task", label: tr("Optional task"), type: "bool", def: false }, ...OBJECT_COMMON];

export const TASK_TYPES: TypeDef[] = [
	{
		type: "item",
		label: tr("Item"),
		fields: [
			{ key: "item", label: tr("Item"), type: "item" },
			{ key: "count", label: tr("Count"), type: "long", def: 1, min: 1 },
			{ key: "consume_items", label: tr("Consume items"), type: TRI },
			{ key: "only_from_crafting", label: tr("Only from crafting"), type: TRI },
			{ key: "match_components", label: tr("Match components"), type: "enum", def: "none", options: ["none", "fuzzy", "strict"] },
			{ key: "task_screen_only", label: tr("Task Screen only"), type: "bool", def: false },
		],
		init: () => ({ item: compound({ count: int(1), id: str("minecraft:dirt") }, true) }),
	},
	{ type: "checkmark", label: tr("Checkmark"), fields: [] },
	{
		type: "kill",
		label: tr("Kill"),
		fields: [
			{ key: "entity", label: tr("Entity"), type: "string", hint: "entity", always: true, def: "minecraft:zombie" },
			{ key: "entityTypeTag", label: tr("Entity type tag"), type: "string", def: "" },
			{ key: "value", label: tr("Count"), type: "long", def: 1, always: true, min: 1 },
			{ key: "custom_name", label: tr("Custom name"), type: "string", def: "" },
			{ key: "nbt_filter", label: tr("NBT filter"), type: "string", def: "" },
		],
	},
	{
		type: "location",
		label: tr("Location"),
		fields: [
			{ key: "dimension", label: tr("Dimension"), type: "string", hint: "dimension", always: true, def: "minecraft:overworld" },
			{ key: "ignore_dimension", label: tr("Ignore dimension"), type: "bool", def: false, always: true },
			{ key: "position", label: tr("Position x y z"), type: "int3", always: true },
			{ key: "size", label: tr("Size w h d"), type: "int3", always: true },
		],
		init: () => ({ position: intArray([0, 0, 0]), size: intArray([1, 1, 1]) }),
	},
	{
		type: "dimension",
		label: tr("Dimension"),
		fields: [{ key: "dimension", label: tr("Dimension"), type: "string", hint: "dimension", always: true, def: "minecraft:the_nether" }],
	},
	{
		type: "biome",
		label: tr("Biome"),
		fields: [{ key: "biome", label: tr("Biome (or #tag)"), type: "string", hint: "biome", always: true, def: "minecraft:plains" }],
	},
	{
		type: "structure",
		label: tr("Structure"),
		fields: [{ key: "structure", label: tr("Structure (or #tag)"), type: "string", hint: "structure", always: true, def: "minecraft:village_plains" }],
	},
	{
		type: "advancement",
		label: tr("Advancement"),
		fields: [
			{ key: "advancement", label: tr("Advancement"), type: "string", hint: "advancement", always: true, def: "minecraft:story/root" },
			{ key: "criterion", label: tr("Criterion"), type: "string", always: true, def: "" },
		],
	},
	{
		type: "observation",
		label: tr("Observation"),
		fields: [
			{
				key: "observation_type",
				label: tr("Type"),
				type: "enum",
				always: true,
				def: "block",
				options: ["block", "block_tag", "block_state", "block_entity", "block_entity_type", "entity_type", "entity_type_tag"],
			},
			{ key: "to_observe", label: tr("To observe"), type: "string", always: true, def: "minecraft:dirt" },
			{ key: "timer", label: tr("Timer (ticks)"), type: "long", always: true, def: 0, min: 0 },
		],
	},
	{
		type: "stat",
		label: tr("Stat"),
		fields: [
			{ key: "stat", label: tr("Stat"), type: "string", always: true, def: "minecraft:mob_kills" },
			{ key: "value", label: tr("Value"), type: "int", always: true, def: 1, min: 1 },
		],
	},
	{
		type: "xp",
		label: tr("XP"),
		fields: [
			{ key: "value", label: tr("Count"), type: "long", always: true, def: 1, min: 1 },
			{ key: "points", label: tr("Points (not levels)"), type: "bool", always: true, def: false },
		],
	},
	{
		type: "fluid",
		label: tr("Fluid"),
		fields: [
			{ key: "fluid", label: tr("Fluid"), type: "fluid" },
			{ key: "amount", label: tr("Amount (mB)"), type: "long", def: 1000, always: true, min: 1 },
		],
		init: () => ({ fluid: compound({ amount: int(1000), id: str("minecraft:water") }, true) }),
	},
	{
		type: "forge_energy",
		label: tr("Energy (FE)"),
		fields: [
			{ key: "value", label: tr("FE amount"), type: "long", always: true, def: 10000, min: 1 },
			{ key: "max_input", label: tr("Max input / tick"), type: "long", def: 0, min: 0 },
		],
	},
	{
		type: "gamestage",
		label: tr("Game stage"),
		fields: [
			{ key: "stage", label: tr("Stage"), type: "string", always: true, def: "" },
			{ key: "team_stage", label: tr("Team stage"), type: "bool", def: false },
		],
	},
	{ type: "custom", label: "Custom (KubeJS)", fields: [] },
];

// ----- rewards -----------------------------------------------------------------

export const REWARD_COMMON: FieldDef[] = [
	{ key: "team_reward", label: tr("Team reward"), type: TRI },
	{ key: "auto", label: tr("Auto-claim"), type: "enum", def: "default", options: ["default", "disabled", "enabled", "no_toast", "invisible"] },
	{ key: "exclude_from_claim_all", label: tr("Exclude from Claim All"), type: "bool", def: false },
	{ key: "ignore_reward_blocking", label: tr("Ignore reward blocking"), type: "bool", def: false },
	{ key: "disable_reward_screen_blur", label: tr("No reward screen blur"), type: "bool", def: false },
	...OBJECT_COMMON,
];

const TABLE_FIELDS: FieldDef[] = [{ key: "table_id", label: tr("Reward table"), type: "table", always: true }];

export const REWARD_TYPES: TypeDef[] = [
	{
		type: "item",
		label: tr("Item"),
		fields: [
			{ key: "item", label: tr("Item"), type: "item" },
			{ key: "count", label: tr("Count"), type: "int", def: 1, min: 1 },
			{ key: "random_bonus", label: tr("Random bonus"), type: "int", def: 0, min: 0 },
			{ key: "only_one", label: tr("Only one per team"), type: "bool", def: false },
		],
		init: () => ({ item: compound({ count: int(1), id: str("minecraft:diamond") }) }),
	},
	{ type: "xp", label: tr("XP"), fields: [{ key: "xp", label: tr("XP points"), type: "int", always: true, def: 100, min: 0 }] },
	{ type: "xp_levels", label: tr("XP levels"), fields: [{ key: "xp_levels", label: tr("Levels"), type: "int", always: true, def: 5, min: 0 }] },
	{
		type: "command",
		label: tr("Command"),
		fields: [
			{ key: "command", label: tr("Command"), type: "string", always: true, def: "/say Hi, {p}!", desc: tr("{p} = player, {x} {y} {z} = position") },
			{ key: "permission_level", label: tr("Permission level"), type: "int", def: 0, min: 0 },
			{ key: "silent", label: tr("Silent"), type: "bool", def: false },
			{ key: "feedback_message", label: tr("Feedback message"), type: "string", def: "" },
		],
	},
	{ type: "random", label: tr("Random from table"), fields: TABLE_FIELDS },
	{ type: "choice", label: tr("Choice from table"), fields: TABLE_FIELDS },
	{ type: "all_table", label: tr("All of table"), fields: TABLE_FIELDS },
	{ type: "loot", label: tr("Loot crate"), fields: TABLE_FIELDS },
	{
		type: "advancement",
		label: tr("Advancement"),
		fields: [
			{ key: "advancement", label: tr("Advancement"), type: "string", always: true, def: "minecraft:story/root" },
			{ key: "criterion", label: tr("Criterion"), type: "string", always: true, def: "" },
		],
	},
	{ type: "toast", label: tr("Toast"), fields: [{ key: "description", label: tr("Text"), type: "string", always: true, def: "" }] },
	{
		type: "gamestage",
		label: tr("Game stage"),
		fields: [
			{ key: "stage", label: tr("Stage"), type: "string", always: true, def: "" },
			{ key: "remove", label: tr("Remove stage"), type: "bool", def: false },
		],
	},
	{ type: "currency", label: tr("Currency"), fields: [{ key: "amount", label: tr("Amount"), type: "int", always: true, def: 1, min: 0 }] },
	{ type: "custom", label: "Custom (KubeJS)", fields: [] },
];

// ----- quests / chapters / images / tables / file --------------------------------

export const QUEST_FIELDS: FieldDef[] = [
	{ key: "size", label: tr("Size"), type: "double", def: 0, desc: tr("0 = chapter default size") },
	{ key: "icon_scale", label: tr("Icon scale"), type: "double", def: 1 },
	{ key: "min_width", label: tr("Min. window width"), type: "int", def: 0, min: 0 },
	{ key: "optional", label: tr("Optional"), type: "bool", def: false },
	{ key: "invisible", label: tr("Invisible until completed"), type: "bool", def: false },
	{ key: "invisible_until_tasks", label: tr("Invisible until N tasks"), type: "int", def: 0, min: 0 },
	{ key: "hide_dependency_lines", label: tr("Hide dependency lines"), type: TRI },
	{ key: "hide_dependent_lines", label: tr("Hide dependent lines"), type: "bool", def: false },
	{ key: "hide_until_deps_visible", label: tr("Hide until dependencies visible"), type: TRI },
	{ key: "hide_until_deps_complete", label: tr("Hide until dependencies complete"), type: TRI },
	{ key: "hide_details_until_startable", label: tr("Hide details until startable"), type: TRI },
	{ key: "hide_text_until_complete", label: tr("Hide text until complete"), type: TRI },
	{ key: "hide_lock_icon", label: tr("Hide lock icon"), type: "bool", def: false },
	{ key: "dependency_requirement", label: tr("Dependency requirement"), type: "enum", def: "all_completed", options: ["all_completed", "one_completed", "all_started", "one_started"] },
	{ key: "min_required_dependencies", label: tr("Min. required dependencies"), type: "int", def: 0, min: 0 },
	{ key: "max_completable_dependents", label: tr("Max. completable dependents"), type: "int", def: 0, min: 0, desc: tr("Exclusive branches: how many child quests can be completed") },
	{ key: "progression_mode", label: tr("Progression mode"), type: "enum", def: "default", options: ["default", "linear", "flexible"] },
	{ key: "require_sequential_tasks", label: tr("Sequential tasks"), type: TRI },
	{ key: "can_repeat", label: tr("Repeatable"), type: TRI },
	{ key: "repeat_cooldown", label: tr("Repeat cooldown (s)"), type: "int", def: 0, min: 0 },
	{ key: "ignore_reward_blocking", label: tr("Ignore reward blocking"), type: "bool", def: false },
	{ key: "disable_recipe_mod", label: tr("Hide from JEI"), type: TRI },
	{ key: "guide_page", label: tr("Guide page"), type: "string", def: "" },
	...OBJECT_COMMON,
];

export const CHAPTER_FIELDS: FieldDef[] = [
	{ key: "default_quest_shape", label: tr("Default shape"), type: "enum", always: true, def: "", options: ["", "circle", "square", "rsquare", "diamond", "pentagon", "hexagon", "octagon", "heart", "gear", "none"] },
	{ key: "default_quest_size", label: tr("Quest size"), type: "double", def: 1 },
	{ key: "default_min_width", label: tr("Min. window width"), type: "int", def: 0, min: 0 },
	{ key: "default_hide_dependency_lines", label: tr("Hide dependency lines"), type: "bool", def: false, always: true },
	{ key: "always_invisible", label: tr("Always invisible"), type: "bool", def: false },
	{ key: "progression_mode", label: tr("Progression mode"), type: "enum", def: "default", options: ["default", "linear", "flexible"] },
	{ key: "consume_items", label: tr("Consume items"), type: TRI },
	{ key: "hide_quest_details_until_startable", label: tr("Hide details until startable"), type: "bool", def: false },
	{ key: "hide_quest_until_deps_visible", label: tr("Hide quests until dependencies visible"), type: "bool", def: false },
	{ key: "hide_quest_until_deps_complete", label: tr("Hide quests until dependencies complete"), type: "bool", def: false },
	{ key: "hide_text_until_complete", label: tr("Hide text until complete"), type: "bool", def: false },
	{ key: "default_repeatable_quest", label: tr("Quests repeatable"), type: "bool", def: false },
	{ key: "require_sequential_tasks", label: tr("Sequential tasks"), type: "bool", def: false },
	{ key: "autofocus_id", label: tr("Autofocus quest"), type: "quest", def: "" },
	...OBJECT_COMMON,
];

export const IMAGE_FIELDS: FieldDef[] = [
	{ key: "image", label: tr("Texture"), type: "string", always: true, def: "minecraft:textures/block/stone.png" },
	{ key: "x", label: "X", type: "double", always: true, def: 0 },
	{ key: "y", label: "Y", type: "double", always: true, def: 0 },
	{ key: "width", label: tr("Width"), type: "double", always: true, def: 1 },
	{ key: "height", label: tr("Height"), type: "double", always: true, def: 1 },
	{ key: "rotation", label: tr("Rotation"), type: "double", always: true, def: 0 },
	{ key: "color", label: tr("Color (RGB int)"), type: "int", def: 0xffffff },
	{ key: "alpha", label: tr("Alpha 0–255"), type: "int", def: 255, min: 0 },
	{ key: "order", label: tr("Order (layer)"), type: "int", def: 0 },
	{ key: "click_action", label: tr("Click action"), type: "string", def: "" },
	{ key: "dependency", label: tr("Show after quest"), type: "quest", def: "" },
	{ key: "dev", label: tr("Editors only"), type: "bool", def: false },
	{ key: "corner", label: tr("Align to corner"), type: "bool", def: false },
	{ key: "position_locked", label: tr("Lock position"), type: "bool", def: false },
	{ key: "text_on_image", label: tr("Text on image"), type: "bool", def: false },
	{ key: "text_shadow", label: tr("Text shadow"), type: "bool", def: false },
	{ key: "text_inset", label: tr("Text inset"), type: "int", def: 0 },
	{ key: "text_h_align", label: tr("Horizontal align"), type: "enum", def: "center", options: ["left", "center", "right"] },
	{ key: "text_v_align", label: tr("Vertical align"), type: "enum", def: "center", options: ["top", "center", "bottom"] },
];

export const REWARD_TABLE_FIELDS: FieldDef[] = [
	{ key: "loot_size", label: tr("Loot size"), type: "int", always: true, def: 1, min: 1 },
	{ key: "empty_weight", label: tr("Empty weight"), type: "float", def: 0, min: 0 },
	{ key: "hide_tooltip", label: tr("Hide tooltip"), type: "bool", def: false },
	{ key: "use_title", label: tr("Use title"), type: "bool", def: false },
	{ key: "loot_table_id", label: tr("Vanilla loot table"), type: "string", def: "" },
	...OBJECT_COMMON,
];

export const FILE_FIELDS: FieldDef[] = [
	{ key: "default_reward_team", label: tr("Team rewards"), type: "bool", always: true, def: false },
	{ key: "default_consume_items", label: tr("Consume items"), type: "bool", always: true, def: false },
	{ key: "default_autoclaim_rewards", label: tr("Auto-claim"), type: "enum", always: true, def: "disabled", options: ["disabled", "enabled", "no_toast", "invisible"] },
	{ key: "default_quest_shape", label: tr("Quest shape"), type: "enum", always: true, def: "circle", options: CHAPTER_FIELDS[0]!.options!.slice(1) },
	{ key: "default_quest_disable_jei", label: tr("Hide in JEI"), type: "bool", always: true, def: false },
	{ key: "progression_mode", label: tr("Progression mode"), type: "enum", always: true, def: "flexible", options: ["linear", "flexible"] },
	{ key: "grid_scale", label: tr("Grid scale"), type: "double", always: true, def: 0.5 },
	{ key: "detection_delay", label: tr("Detection delay (ticks)"), type: "int", always: true, def: 20, min: 0 },
	{ key: "emergency_items_cooldown", label: tr("Emergency items cooldown (s)"), type: "int", always: true, def: 300, min: 0 },
	{ key: "pause_game", label: tr("Pause game"), type: "bool", always: true, def: false },
	{ key: "disable_gui", label: tr("Disable GUI"), type: "bool", always: true, def: false },
	{ key: "drop_book_on_death", label: tr("Drop book on death"), type: "bool", always: true, def: false },
	{ key: "drop_loot_crates", label: tr("Drop loot crates"), type: "bool", always: true, def: false },
	{ key: "hide_excluded_quests", label: tr("Hide excluded quests"), type: "bool", always: true, def: false },
	{ key: "show_lock_icons", label: tr("Show lock icons"), type: "bool", always: true, def: false },
	{ key: "verify_on_load", label: tr("Verify on load"), type: "bool", always: true, def: false },
	{ key: "lock_message", label: tr("Lock message"), type: "string", always: true, def: "" },
	{ key: "fallback_locale", label: tr("Fallback locale"), type: "string", always: true, def: "" },
];

/** Lang (translatable) fields per object kind. */
export const LANG_FIELDS: Record<string, { field: string; label: string; multiline?: boolean }[]> = {
	chapter: [
		{ field: "title", label: tr("Title") },
		{ field: "chapter_subtitle", label: tr("Subtitle"), multiline: true },
	],
	chapter_group: [{ field: "title", label: tr("Title") }],
	quest: [
		{ field: "title", label: tr("Title") },
		{ field: "quest_subtitle", label: tr("Subtitle") },
		{ field: "quest_desc", label: tr("Description"), multiline: true },
	],
	task: [{ field: "title", label: tr("Title") }],
	reward: [{ field: "title", label: tr("Title") }],
	reward_table: [{ field: "title", label: tr("Title") }],
};

export function taskType(type: string | undefined): TypeDef | undefined {
	return TASK_TYPES.find((t) => t.type === type);
}

export function rewardType(type: string | undefined): TypeDef | undefined {
	return REWARD_TYPES.find((t) => t.type === type);
}

// ----- value conversion --------------------------------------------------------

export function intArray(values: number[]): ArrayNode {
	return { kind: "array", arrayType: "I", inline: true, items: values.map((v) => int(Math.round(v))) };
}

/** Typed SNBT node for a field value. */
export function fieldNode(f: FieldDef, value: string | number | boolean): SnbtNode {
	switch (f.type) {
		case "bool":
		case "tristate":
			return bool(Boolean(value));
		case "int":
		case "int_enum":
			return int(Math.round(Number(value)));
		case "long":
			return long(Math.round(Number(value)));
		case "double":
			return double(Number(value));
		case "float":
			return num("f", Number(value));
		case "table":
			return long(String(value));
		default:
			return str(String(value));
	}
}

/** Whether the value should be removed instead of written. */
export function isDefault(f: FieldDef, value: string | number | boolean | undefined): boolean {
	if (f.always) return false;
	if (value === undefined || value === "") return true;
	if (f.def === undefined) return false;
	if (typeof f.def === "number") return Number(value) === f.def;
	return value === f.def;
}

/** Fields a new task / reward of `def` starts with (always-written keys get their defaults). */
export function defaultFields(def: TypeDef): Record<string, SnbtNode> {
	const out: Record<string, SnbtNode> = { type: str(def.type), ...(def.init?.() ?? {}) };
	for (const f of def.fields) {
		if (out[f.key] || !f.always || f.def === undefined) continue;
		out[f.key] = fieldNode(f, f.def);
	}
	// Observation tasks also store the ordinal; FTB reads it first.
	if (def.type === "observation") out.observe_type = int(0);
	return out;
}

export function isCompound(n: SnbtNode | undefined): n is CompoundNode {
	return n?.kind === "compound";
}
