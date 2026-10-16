# FTB Quests Editor for Obsidian

A visual editor for **FTB Quests** questbooks that runs inside Obsidian, so you never have to launch Minecraft.
Point it at your modpack's `config/ftbquests/quests` folder and it shows each chapter the way the game does: quests, item icons, dependency lines and banners.
Every change is written back to the same `.snbt` files, and the game reads them as usual.

> Built and tested against **FTB Quests 2101.1.x (NeoForge 1.21.1)**. Desktop only (Windows / macOS / Linux).

---

## Installation

### Option 1. From a release (recommended)
1. Open [Releases](https://github.com/MinestarUA/Obsidian-plugin-FTBQ/releases) and download `ftbquests-editor-<version>.zip`.
2. Unzip it into `<your vault>/.obsidian/plugins/`. You should end up with `.obsidian/plugins/ftbquests-editor/` containing `main.js`, `manifest.json` and `styles.css`.
3. In Obsidian go to **Settings → Community plugins**, turn off *Restricted mode* if it is on, press ⟳ and enable **FTB Quests Editor**.

### Option 2. With BRAT (auto-updates)
1. Install the **BRAT** plugin from Community plugins.
2. Run *BRAT: Add a beta plugin for testing* and paste `MinestarUA/Obsidian-plugin-FTBQ`.

### Option 3. From source
```bash
git clone https://github.com/MinestarUA/Obsidian-plugin-FTBQ.git
cd Obsidian-plugin-FTBQ
npm install
OBSIDIAN_PLUGIN_DIR="<vault>/.obsidian/plugins/ftbquests-editor" npm run build
```

---

## First-time setup

**Settings → FTB Quests Editor**:

| Setting | What to enter |
|---|---|
| **Quests folder** | Path to `ftbquests/quests`. Either absolute (`/home/me/.minecraft/config/ftbquests/quests`, `C:\Users\me\...\config\ftbquests\quests`) or relative to the vault. The default is `config/ftbquests/quests`, i.e. a vault opened directly in the instance folder. |
| **Text locale** | Language that titles and descriptions are written to: `en_us`, `uk_ua`, etc. This is the file name in `quests/lang/`. |
| **Icon sources** | Optional. Where item icons come from, one path per line: the modpack's `mods` folder and the Minecraft client jar, e.g. `…/libraries/com/mojang/minecraft/1.21.1/minecraft-1.21.1-client.jar`. Without them, quests show text instead of icons. |
| **Autosave delay (ms)** | `0` saves only when you ask (Ctrl+S). Any other number autosaves that many milliseconds after an edit. |
| **Backups to keep** | How many backups to keep. Before every write, the previous version of the file is copied to `.obsidian/plugins/ftbquests-editor/backups/`. |

Then click the **⑂** ribbon icon or run the *Open quest graph editor* command.

---

## Usage

The window has three parts:

- **Left: chapters and groups.**
  - Click a chapter to open it.
  - Right-click a chapter to reorder it, move it to a group, rename its file or delete it.
  - Right-click a group to rename, reorder or delete it.
  - At the bottom are **+ Group**, **🎁 Tables** (reward tables) and **⚙ File** (global `data.snbt` settings).
- **Centre: the chapter canvas.**
- **Right: properties** of the current selection — a chapter, a quest, an image, several quests at once, or a dependency line.

### Common tasks

| Task | How |
|---|---|
| Create a quest | Right-click empty space → pick a task type. Or double-click. |
| Title and description | Select the quest → **Title / Subtitle / Description** on the right. Colour codes `&6`, `&l`, `&r` are supported. |
| Add a task or reward | In the quest's properties use **+ Task / + Reward** → pick a type. Expand "parameters" to edit its fields. |
| Add a dependency | Select quest A → right-click quest B → *Add selected as dependencies* (B now requires A). Or Ctrl+drag from A to B. |
| Several dependencies at once | Select several quests (Ctrl+click or a middle-button box) → right-click the target quest. |
| Move | Drag with the mouse. Or middle-click, then click again where it should go. |
| Quest from another chapter | Right-click empty space → *Link a quest from another chapter…*. Or Ctrl+C on a quest and Ctrl+Alt+V in another chapter. |
| Banner or image | Right-click empty space → *Image*. Or **+ Image** in the chapter properties. Move it with a middle-click. |
| Random rewards | **🎁 Tables** → create a table. Then add a *Random from table / Choice / All of table* reward to a quest. |
| Save | **💾** or **Ctrl+S**. Then run `/ftbquests reload` in game. |

### Controls (same as the in-game FTB Quests editor)

| Mouse | Action |
|---|---|
| Left-click a quest | open its properties |
| Ctrl + left-click | add to / remove from the selection |
| Middle-click a quest or image | pick it up and move it; click again to drop it, right-click or Esc to cancel, Shift to ignore the grid |
| Middle-drag, or Alt + left-drag | selection box (with Ctrl, toggle what is inside the box) |
| Left- or right-drag on empty space | pan the canvas |
| Wheel / Shift + wheel / Ctrl + wheel | scroll / scroll sideways / zoom |
| Right-click | context menu |
| Right Alt + left-click a quest | copy its ID |
| Left-drag a quest, Ctrl + drag onto another quest | move, add a dependency (this editor only) |

| Keys | Action |
|---|---|
| Ctrl+A / Ctrl+D / Esc | select all / clear selection / cancel |
| Ctrl+C / Ctrl+V | copy / paste a quest or image at the cursor |
| Ctrl+Shift+V / Ctrl+Alt+V | paste without dependencies / paste as a link |
| Del / Shift+Del | delete with confirmation / delete immediately |
| Arrow keys | scroll; while moving, or with Ctrl, nudge the selection (0.5, or 0.1 with Shift) |
| Ctrl+Z / Ctrl+Y | undo / redo |
| Ctrl+S | save |
| Ctrl+T / Ctrl+P / Ctrl+F | reward tables / settings / find a quest |
| Ctrl+R | show / hide the grid |
| Tab / Shift+Tab | next / previous chapter |
| Space or F, `-` `=` `0` | fit everything, zoom, reset zoom |

The full cheat sheet is behind the **?** button in the toolbar.

The interface is in English. If Obsidian itself is set to Ukrainian (Settings → General → Language), the plugin switches to Ukrainian too.

### What you can edit
- **Tasks (15 types):** item, checkmark, kill, location, dimension, biome, structure, advancement, observation, stat, xp, fluid, forge_energy, gamestage, custom.
- **Rewards (13 types):** item, xp, xp_levels, command, random, choice, all_table, loot, advancement, toast, gamestage, currency, custom.
- **Quests:** shape, size, visibility, repeating, progression mode, min/max dependencies, hiding in JEI, icon, tags and more.
- **Chapters:** group, order, all `default_*` and `hide_*` options, autofocus, images.
- **Reward tables and `data.snbt`.**

Fields the editor does not know about (item components, filters, data from other mods) are kept exactly as they are.

---

## Data safety
- **Lossless format.** Unchanged parts of a file are written back byte for byte; changed parts are written the way FTB itself writes them. Object IDs never change, so player progress is never reset.
- **Checks before saving.** You cannot save if an edit created a duplicate ID, a dangling reference or a dependency cycle. *Validate quests* lists every problem.
- **Conflicts.** If a file changes on disk (the game, git, another editor), files without unsaved edits reload automatically. For files you have edited, the plugin asks *Keep mine* or *Take disk version* and never overwrites anything silently.
- **Backups** of every written file are kept in the plugin folder.

> ⚠️ Do not edit quests in the game and in Obsidian at the same time. Save in one place, then reload in the other (`/ftbquests reload` in game).

### Commands (Ctrl+P)
*Open quest graph editor* · *Save quests* · *Reload quests from disk* · *Undo / Redo quest edit* · *Validate quests* · *Resolve quest file conflicts*.

---

## Development
```bash
npm install
npm test        # parser, mutation and sync tests
npm run build   # tsc + esbuild → main.js in the repo root
OBSIDIAN_PLUGIN_DIR="<vault>/.obsidian/plugins/ftbquests-editor" npm run dev   # watch build straight into a vault
```
Tests against a real questbook run when `FTBQ_CORPUS=<path to ftbquests/quests>` is set.

**Releasing:**
1. `npm version 0.3.0` updates `manifest.json` and `versions.json`.
2. `git push --follow-tags` makes GitHub Actions build the plugin and publish a release with `main.js`, `manifest.json`, `styles.css` and a zip.

How the core works and why: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## License

[MIT](LICENSE) © 2026 ProstoMaslo.

You may freely use, modify, distribute and embed this plugin in your own projects, including commercial ones, **on one condition: keep the author credit**.
The line `Copyright (c) 2026 ProstoMaslo` and the license text must stay in all copies and derivative works.
