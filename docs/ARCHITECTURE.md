# Architecture

## Layout

| File | Role |
|---|---|
| `src/engine/snbtLexer.ts` | FTB-SNBT tokenizer with offsets; keeps every character between tokens |
| `src/engine/snbtParser.ts` | SNBT → CST; every node remembers its `origin` (source, span, indent, snapshot of its children) |
| `src/engine/snbtSerializer.ts` | CST → text: unchanged subtrees are copied verbatim, changed ones are printed canonically, exactly as FTB prints them |
| `src/engine/snbtNodes.ts` | node types, builders, get/set/remove helpers, Java-style `double`/`float` formatting |
| `src/engine/questModel.ts` | typed view of the quests folder; global `IdIndex` with reverse references |
| `src/engine/graphMutator.ts` | CRUD for chapters, quests, tasks and rewards; dependencies with cycle checks; quest links; snap-to-grid; collision avoidance; images; reward tables; copy/paste |
| `src/engine/schema.ts` | every field of FTB Quests 2101.1.x: 15 task types, 13 reward types, quest, chapter, image, reward table, `data.snbt` |
| `src/engine/validator.ts` | schema and integrity checks (unique ids, dangling references, cycles, `filename`, orphaned lang keys) |
| `src/state/store.ts` | transactions, undo/redo on text snapshots, dirty tracking, events |
| `src/sync/fileWatcher.ts` | atomic writes, optimistic concurrency, conflicts, backups, `fs.watch` + polling |
| `src/ui/graphCanvas.ts` | Canvas2D renderer and the FTB-style mouse controls |
| `src/ui/questView.ts` | the editor view: chapter list, toolbar, inspector, context menus, keyboard shortcuts |
| `src/ui/fields.ts` | property editors generated from the schema (bool, tristate, numbers, enums, item/icon, fluid, `[I;x,y,z]`, quest, table, tags) |
| `src/i18n.ts` | UI strings: English by default, Ukrainian when Obsidian runs in Ukrainian |
| `src/main.ts` | the Obsidian plugin: settings, commands, status bar, validation and conflict dialogs |

## Design decisions and risks

The original proposal was *"a pure TypeScript AST parser in the renderer process, writing every change synchronously to `.snbt`, with an HTML5 Canvas UI"*.

### 1. SNBT compatibility and data loss
- **How real the danger is.** The FTB reader ignores key order and whitespace, accepts both commas and newlines, and coerces numeric types itself.
  Player progress is stored in the world save, keyed by object id, not in these files.
  So reordering keys or reformatting will **not** break the game. Three things actually are dangerous:
  1. dropping unknown fields: `components`, `"irons_spellbooks:spell_container"`, filters;
  2. changing the id of an existing object, which resets progress;
  3. leaving dangling references.
- **Why an AST is not enough.** An AST loses formatting by definition, so this project uses a **CST**. A number is stored as text plus its type (`b s i L f d`) and never passes through a JS `number` until it is edited.
  `true/false` stay booleans instead of becoming `1b`. Keys are not re-sorted; a new key is inserted at its sorted position.
- **Guarantee.** On a real modpack (18 files, 13 chapters, a 224 KB lang file) `parse → serialize` reproduces every file byte for byte.
  Even the *canonical* mode, which ignores the original layout entirely, reproduces them byte for byte, so the printer matches what FTB writes.
  Editing changes only the edited lines, and the tests cover this.
- **What blocks a save:**
  1. Round-trip: the saved text must parse back to the same text.
  2. Validator: saving is refused if an edit introduced **new** errors. Errors that were already in the files when they were loaded are shown as warnings only; otherwise existing files could never be saved.
  3. Immutable ids: `setField(..., "id")` throws, and `moveQuestToChapter` keeps the id.

### 2. Sync collisions (Minecraft / git)
- "Synchronous write on every change" was **rejected**. It blocks the renderer, writes half-finished edits and is guaranteed to collide with Minecraft and git.
  Transactions are written on an explicit *Save* or by a debounced autosave instead.
- **Atomic writes:** a temp file `.<name>.snbt.<pid>.<ts>.tmp` in the same folder, then fsync and rename.
  The name does not end in `.snbt`, so FTB never loads it as a chapter.
- **Optimistic concurrency.** The last text seen on disk is remembered for every file. Before writing, each dirty file is re-read from disk; if it differs, the file becomes a conflict and is **not overwritten**.
  Any conflict blocks saving the *whole* project, because a single quest edit touches both the chapter and the lang file.
- **External changes.** A clean file reloads silently. A file with unsaved edits becomes a conflict with a choice of "Keep mine" or "Take disk version".
  Events are debounced by 300 ms, so a git checkout triggers a single pass. The plugin recognises and ignores its own writes. Polling on mtime catches events `fs.watch` misses.
- **Backups.** Before every write, the previous on-disk version goes to `backups/<timestamp>/` in the plugin folder (the last N are kept; the folder is git-ignored).
- ⚠️ **Minecraft limitation.** FTB keeps quests in memory and rewrites the files when you edit in game. After saving in Obsidian, run `/ftbquests reload`.
  If the game overwrites a file you have just saved, the plugin notices and warns you.

### 3. Canvas or SVG
FTB shows one chapter at a time, and the largest chapter in a big modpack has around 200 quests.
SVG/DOM is comfortable up to roughly 1–2k nodes, while Canvas wins at pan/zoom with thousands of edges.
**Chosen:** Canvas2D (redraw via requestAnimationFrame, culling of off-screen nodes) plus a DOM properties panel.

## Known limitations / unverified
- The `table_id` format for reward tables in 1.21 is not verified against real data, so both a string and a long are accepted.
- Per-chapter lang files in newer FTB builds (`lang/<locale>/*.snbt`) are not verified: they are read, but new keys are written to `lang/<locale>.snbt`.
- Extra lang files such as `uk_ua_old.snbt` are loaded as a separate "locale"; FTB probably reads them too, so it is better to remove them.
- There is no 3-way merge for conflicts, only "Keep mine / Take disk version".
