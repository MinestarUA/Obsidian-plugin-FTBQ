/**
 * Field schema of every FTB Quests object, taken from the `writeData` / `readData` methods of
 * FTB Quests 2101.1.x (NeoForge 1.21.1). The UI renders editors from these descriptors, and the
 * `defaultFields` builders create new tasks / rewards the way FTB itself would write them.
 *
 * Unknown fields are never touched: the editor only reads and writes the keys listed here.
 */

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
	{ key: "icon", label: "Іконка", type: "icon" },
	{ key: "disable_toast", label: "Без сповіщення (toast)", type: "bool", def: false },
	{ key: "tags", label: "Теги", type: "tags" },
	{ key: "custom_id", label: "Custom id", type: "string", def: "" },
];

// ----- tasks -------------------------------------------------------------------

export const TASK_COMMON: FieldDef[] = [{ key: "optional_task", label: "Необов'язкове завдання", type: "bool", def: false }, ...OBJECT_COMMON];

export const TASK_TYPES: TypeDef[] = [
	{
		type: "item",
		label: "Предмет",
		fields: [
			{ key: "item", label: "Предмет", type: "item" },
			{ key: "count", label: "Кількість", type: "long", def: 1, min: 1 },
			{ key: "consume_items", label: "Забирати предмети", type: TRI },
			{ key: "only_from_crafting", label: "Лише з крафту", type: TRI },
			{ key: "match_components", label: "Порівнювати компоненти", type: "enum", def: "none", options: ["none", "fuzzy", "strict"] },
			{ key: "task_screen_only", label: "Лише через Task Screen", type: "bool", def: false },
		],
		init: () => ({ item: compound({ count: int(1), id: str("minecraft:dirt") }, true) }),
	},
	{ type: "checkmark", label: "Галочка", fields: [] },
	{
		type: "kill",
		label: "Вбивство",
		fields: [
			{ key: "entity", label: "Сутність", type: "string", hint: "entity", always: true, def: "minecraft:zombie" },
			{ key: "entityTypeTag", label: "Тег сутностей", type: "string", def: "" },
			{ key: "value", label: "Кількість", type: "long", def: 1, always: true, min: 1 },
			{ key: "custom_name", label: "Ім'я (custom name)", type: "string", def: "" },
			{ key: "nbt_filter", label: "NBT-фільтр", type: "string", def: "" },
		],
	},
	{
		type: "location",
		label: "Локація",
		fields: [
			{ key: "dimension", label: "Вимір", type: "string", hint: "dimension", always: true, def: "minecraft:overworld" },
			{ key: "ignore_dimension", label: "Ігнорувати вимір", type: "bool", def: false, always: true },
			{ key: "position", label: "Позиція x y z", type: "int3", always: true },
			{ key: "size", label: "Розмір w h d", type: "int3", always: true },
		],
		init: () => ({ position: intArray([0, 0, 0]), size: intArray([1, 1, 1]) }),
	},
	{
		type: "dimension",
		label: "Вимір",
		fields: [{ key: "dimension", label: "Вимір", type: "string", hint: "dimension", always: true, def: "minecraft:the_nether" }],
	},
	{
		type: "biome",
		label: "Біом",
		fields: [{ key: "biome", label: "Біом (або #тег)", type: "string", hint: "biome", always: true, def: "minecraft:plains" }],
	},
	{
		type: "structure",
		label: "Структура",
		fields: [{ key: "structure", label: "Структура (або #тег)", type: "string", hint: "structure", always: true, def: "minecraft:village_plains" }],
	},
	{
		type: "advancement",
		label: "Досягнення",
		fields: [
			{ key: "advancement", label: "Досягнення", type: "string", hint: "advancement", always: true, def: "minecraft:story/root" },
			{ key: "criterion", label: "Критерій", type: "string", always: true, def: "" },
		],
	},
	{
		type: "observation",
		label: "Спостереження",
		fields: [
			{
				key: "observation_type",
				label: "Тип",
				type: "enum",
				always: true,
				def: "block",
				options: ["block", "block_tag", "block_state", "block_entity", "block_entity_type", "entity_type", "entity_type_tag"],
			},
			{ key: "to_observe", label: "Що спостерігати", type: "string", always: true, def: "minecraft:dirt" },
			{ key: "timer", label: "Час (тіки)", type: "long", always: true, def: 0, min: 0 },
		],
	},
	{
		type: "stat",
		label: "Статистика",
		fields: [
			{ key: "stat", label: "Статистика", type: "string", always: true, def: "minecraft:mob_kills" },
			{ key: "value", label: "Значення", type: "int", always: true, def: 1, min: 1 },
		],
	},
	{
		type: "xp",
		label: "Досвід",
		fields: [
			{ key: "value", label: "Кількість", type: "long", always: true, def: 1, min: 1 },
			{ key: "points", label: "Очки (не рівні)", type: "bool", always: true, def: false },
		],
	},
	{
		type: "fluid",
		label: "Рідина",
		fields: [
			{ key: "fluid", label: "Рідина", type: "fluid" },
			{ key: "amount", label: "Кількість (mB)", type: "long", def: 1000, always: true, min: 1 },
		],
		init: () => ({ fluid: compound({ amount: int(1000), id: str("minecraft:water") }, true) }),
	},
	{
		type: "forge_energy",
		label: "Енергія (FE)",
		fields: [
			{ key: "value", label: "Кількість FE", type: "long", always: true, def: 10000, min: 1 },
			{ key: "max_input", label: "Макс. вхід/тік", type: "long", def: 0, min: 0 },
		],
	},
	{
		type: "gamestage",
		label: "Ігрова стадія",
		fields: [
			{ key: "stage", label: "Стадія", type: "string", always: true, def: "" },
			{ key: "team_stage", label: "Командна стадія", type: "bool", def: false },
		],
	},
	{ type: "custom", label: "Custom (KubeJS)", fields: [] },
];

// ----- rewards -----------------------------------------------------------------

export const REWARD_COMMON: FieldDef[] = [
	{ key: "team_reward", label: "Командна нагорода", type: TRI },
	{ key: "auto", label: "Автоотримання", type: "enum", def: "default", options: ["default", "disabled", "enabled", "no_toast", "invisible"] },
	{ key: "exclude_from_claim_all", label: "Не в «Отримати все»", type: "bool", def: false },
	{ key: "ignore_reward_blocking", label: "Ігнорувати блокування нагород", type: "bool", def: false },
	{ key: "disable_reward_screen_blur", label: "Без розмиття екрана", type: "bool", def: false },
	...OBJECT_COMMON,
];

const TABLE_FIELDS: FieldDef[] = [{ key: "table_id", label: "Таблиця нагород", type: "table", always: true }];

export const REWARD_TYPES: TypeDef[] = [
	{
		type: "item",
		label: "Предмет",
		fields: [
			{ key: "item", label: "Предмет", type: "item" },
			{ key: "count", label: "Кількість", type: "int", def: 1, min: 1 },
			{ key: "random_bonus", label: "Випадковий бонус", type: "int", def: 0, min: 0 },
			{ key: "only_one", label: "Лише один на команду", type: "bool", def: false },
		],
		init: () => ({ item: compound({ count: int(1), id: str("minecraft:diamond") }) }),
	},
	{ type: "xp", label: "Досвід", fields: [{ key: "xp", label: "Очки досвіду", type: "int", always: true, def: 100, min: 0 }] },
	{ type: "xp_levels", label: "Рівні досвіду", fields: [{ key: "xp_levels", label: "Рівні", type: "int", always: true, def: 5, min: 0 }] },
	{
		type: "command",
		label: "Команда",
		fields: [
			{ key: "command", label: "Команда", type: "string", always: true, def: "/say Hi, {p}!", desc: "{p} — гравець, {x} {y} {z} — позиція" },
			{ key: "permission_level", label: "Рівень прав", type: "int", def: 0, min: 0 },
			{ key: "silent", label: "Тихо", type: "bool", def: false },
			{ key: "feedback_message", label: "Повідомлення", type: "string", def: "" },
		],
	},
	{ type: "random", label: "Випадкова з таблиці", fields: TABLE_FIELDS },
	{ type: "choice", label: "На вибір з таблиці", fields: TABLE_FIELDS },
	{ type: "all_table", label: "Уся таблиця", fields: TABLE_FIELDS },
	{ type: "loot", label: "Лутбокс (loot crate)", fields: TABLE_FIELDS },
	{
		type: "advancement",
		label: "Досягнення",
		fields: [
			{ key: "advancement", label: "Досягнення", type: "string", always: true, def: "minecraft:story/root" },
			{ key: "criterion", label: "Критерій", type: "string", always: true, def: "" },
		],
	},
	{ type: "toast", label: "Сповіщення", fields: [{ key: "description", label: "Текст", type: "string", always: true, def: "" }] },
	{
		type: "gamestage",
		label: "Ігрова стадія",
		fields: [
			{ key: "stage", label: "Стадія", type: "string", always: true, def: "" },
			{ key: "remove", label: "Забрати стадію", type: "bool", def: false },
		],
	},
	{ type: "currency", label: "Валюта", fields: [{ key: "amount", label: "Сума", type: "int", always: true, def: 1, min: 0 }] },
	{ type: "custom", label: "Custom (KubeJS)", fields: [] },
];

// ----- quests / chapters / images / tables / file --------------------------------

export const QUEST_FIELDS: FieldDef[] = [
	{ key: "size", label: "Розмір", type: "double", def: 0, desc: "0 — розмір глави за замовчуванням" },
	{ key: "icon_scale", label: "Масштаб іконки", type: "double", def: 1 },
	{ key: "min_width", label: "Мін. ширина вікна", type: "int", def: 0, min: 0 },
	{ key: "optional", label: "Необов'язковий", type: "bool", def: false },
	{ key: "invisible", label: "Невидимий до виконання", type: "bool", def: false },
	{ key: "invisible_until_tasks", label: "Невидимий до N завдань", type: "int", def: 0, min: 0 },
	{ key: "hide_dependency_lines", label: "Сховати лінії залежностей", type: TRI },
	{ key: "hide_dependent_lines", label: "Сховати лінії залежних", type: "bool", def: false },
	{ key: "hide_until_deps_visible", label: "Сховати, доки залежності не видно", type: TRI },
	{ key: "hide_until_deps_complete", label: "Сховати до виконання залежностей", type: TRI },
	{ key: "hide_details_until_startable", label: "Сховати деталі, доки не доступний", type: TRI },
	{ key: "hide_text_until_complete", label: "Сховати текст до виконання", type: TRI },
	{ key: "hide_lock_icon", label: "Без іконки замка", type: "bool", def: false },
	{ key: "dependency_requirement", label: "Вимога залежностей", type: "enum", def: "all_completed", options: ["all_completed", "one_completed", "all_started", "one_started"] },
	{ key: "min_required_dependencies", label: "Мін. к-сть залежностей", type: "int", def: 0, min: 0 },
	{ key: "max_completable_dependents", label: "Макс. виконуваних залежних", type: "int", def: 0, min: 0, desc: "Ексклюзивні гілки: скільки дочірніх квестів можна виконати" },
	{ key: "progression_mode", label: "Режим прогресії", type: "enum", def: "default", options: ["default", "linear", "flexible"] },
	{ key: "require_sequential_tasks", label: "Завдання по черзі", type: TRI },
	{ key: "can_repeat", label: "Повторюваний", type: TRI },
	{ key: "repeat_cooldown", label: "Кулдаун повтору (с)", type: "int", def: 0, min: 0 },
	{ key: "ignore_reward_blocking", label: "Ігнорувати блокування нагород", type: "bool", def: false },
	{ key: "disable_recipe_mod", label: "Не показувати в JEI", type: TRI },
	{ key: "guide_page", label: "Сторінка гайду", type: "string", def: "" },
	...OBJECT_COMMON,
];

export const CHAPTER_FIELDS: FieldDef[] = [
	{ key: "default_quest_shape", label: "Форма за замовчуванням", type: "enum", always: true, def: "", options: ["", "circle", "square", "rsquare", "diamond", "pentagon", "hexagon", "octagon", "heart", "gear", "none"] },
	{ key: "default_quest_size", label: "Розмір квестів", type: "double", def: 1 },
	{ key: "default_min_width", label: "Мін. ширина вікна", type: "int", def: 0, min: 0 },
	{ key: "default_hide_dependency_lines", label: "Сховати лінії залежностей", type: "bool", def: false, always: true },
	{ key: "always_invisible", label: "Завжди невидима", type: "bool", def: false },
	{ key: "progression_mode", label: "Режим прогресії", type: "enum", def: "default", options: ["default", "linear", "flexible"] },
	{ key: "consume_items", label: "Забирати предмети", type: TRI },
	{ key: "hide_quest_details_until_startable", label: "Сховати деталі, доки не доступні", type: "bool", def: false },
	{ key: "hide_quest_until_deps_visible", label: "Сховати квести, доки залежності не видно", type: "bool", def: false },
	{ key: "hide_quest_until_deps_complete", label: "Сховати квести до виконання залежностей", type: "bool", def: false },
	{ key: "hide_text_until_complete", label: "Сховати текст до виконання", type: "bool", def: false },
	{ key: "default_repeatable_quest", label: "Квести повторювані", type: "bool", def: false },
	{ key: "require_sequential_tasks", label: "Завдання по черзі", type: "bool", def: false },
	{ key: "autofocus_id", label: "Автофокус на квест", type: "quest", def: "" },
	...OBJECT_COMMON,
];

export const IMAGE_FIELDS: FieldDef[] = [
	{ key: "image", label: "Текстура", type: "string", always: true, def: "minecraft:textures/block/stone.png" },
	{ key: "x", label: "X", type: "double", always: true, def: 0 },
	{ key: "y", label: "Y", type: "double", always: true, def: 0 },
	{ key: "width", label: "Ширина", type: "double", always: true, def: 1 },
	{ key: "height", label: "Висота", type: "double", always: true, def: 1 },
	{ key: "rotation", label: "Поворот", type: "double", always: true, def: 0 },
	{ key: "color", label: "Колір (RGB int)", type: "int", def: 0xffffff },
	{ key: "alpha", label: "Прозорість 0–255", type: "int", def: 255, min: 0 },
	{ key: "order", label: "Порядок (шар)", type: "int", def: 0 },
	{ key: "click_action", label: "Дія по кліку", type: "string", def: "" },
	{ key: "dependency", label: "Показати після квесту", type: "quest", def: "" },
	{ key: "dev", label: "Лише для редакторів", type: "bool", def: false },
	{ key: "corner", label: "Вирівняти по куту", type: "bool", def: false },
	{ key: "position_locked", label: "Заблокувати позицію", type: "bool", def: false },
	{ key: "text_on_image", label: "Текст на зображенні", type: "bool", def: false },
	{ key: "text_shadow", label: "Тінь тексту", type: "bool", def: false },
	{ key: "text_inset", label: "Відступ тексту", type: "int", def: 0 },
	{ key: "text_h_align", label: "Гориз. вирівнювання", type: "enum", def: "center", options: ["left", "center", "right"] },
	{ key: "text_v_align", label: "Верт. вирівнювання", type: "enum", def: "center", options: ["top", "center", "bottom"] },
];

export const REWARD_TABLE_FIELDS: FieldDef[] = [
	{ key: "loot_size", label: "Кількість предметів", type: "int", always: true, def: 1, min: 1 },
	{ key: "empty_weight", label: "Вага «нічого»", type: "float", def: 0, min: 0 },
	{ key: "hide_tooltip", label: "Сховати підказку", type: "bool", def: false },
	{ key: "use_title", label: "Використовувати назву", type: "bool", def: false },
	{ key: "loot_table_id", label: "Ванільна loot table", type: "string", def: "" },
	...OBJECT_COMMON,
];

export const FILE_FIELDS: FieldDef[] = [
	{ key: "default_reward_team", label: "Нагороди командні", type: "bool", always: true, def: false },
	{ key: "default_consume_items", label: "Забирати предмети", type: "bool", always: true, def: false },
	{ key: "default_autoclaim_rewards", label: "Автоотримання", type: "enum", always: true, def: "disabled", options: ["disabled", "enabled", "no_toast", "invisible"] },
	{ key: "default_quest_shape", label: "Форма квестів", type: "enum", always: true, def: "circle", options: CHAPTER_FIELDS[0]!.options!.slice(1) },
	{ key: "default_quest_disable_jei", label: "Сховати в JEI", type: "bool", always: true, def: false },
	{ key: "progression_mode", label: "Режим прогресії", type: "enum", always: true, def: "flexible", options: ["linear", "flexible"] },
	{ key: "grid_scale", label: "Крок сітки", type: "double", always: true, def: 0.5 },
	{ key: "detection_delay", label: "Затримка перевірки (тіки)", type: "int", always: true, def: 20, min: 0 },
	{ key: "emergency_items_cooldown", label: "Кулдаун аварійних предметів (с)", type: "int", always: true, def: 300, min: 0 },
	{ key: "pause_game", label: "Пауза в книзі", type: "bool", always: true, def: false },
	{ key: "disable_gui", label: "Вимкнути GUI", type: "bool", always: true, def: false },
	{ key: "drop_book_on_death", label: "Губити книгу при смерті", type: "bool", always: true, def: false },
	{ key: "drop_loot_crates", label: "Лутбокси з мобів", type: "bool", always: true, def: false },
	{ key: "hide_excluded_quests", label: "Сховати виключені квести", type: "bool", always: true, def: false },
	{ key: "show_lock_icons", label: "Іконки замків", type: "bool", always: true, def: false },
	{ key: "verify_on_load", label: "Перевіряти при завантаженні", type: "bool", always: true, def: false },
	{ key: "lock_message", label: "Повідомлення блокування", type: "string", always: true, def: "" },
	{ key: "fallback_locale", label: "Резервна мова", type: "string", always: true, def: "" },
];

/** Lang (translatable) fields per object kind. */
export const LANG_FIELDS: Record<string, { field: string; label: string; multiline?: boolean }[]> = {
	chapter: [
		{ field: "title", label: "Назва" },
		{ field: "chapter_subtitle", label: "Підзаголовок", multiline: true },
	],
	chapter_group: [{ field: "title", label: "Назва" }],
	quest: [
		{ field: "title", label: "Назва" },
		{ field: "quest_subtitle", label: "Підзаголовок" },
		{ field: "quest_desc", label: "Опис", multiline: true },
	],
	task: [{ field: "title", label: "Назва" }],
	reward: [{ field: "title", label: "Назва" }],
	reward_table: [{ field: "title", label: "Назва" }],
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
