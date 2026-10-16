import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Real FTB Quests directory used as a read-only corpus. Override with FTBQ_CORPUS. */
export const CORPUS = process.env.FTBQ_CORPUS ?? join(dirname(fileURLToPath(import.meta.url)), "../../../ftbquests/quests");
export const hasCorpus = existsSync(CORPUS);

export function readTree(root: string): Map<string, string> {
	const out = new Map<string, string>();
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			if (name.startsWith(".")) continue;
			const p = join(dir, name);
			if (statSync(p).isDirectory()) walk(p);
			else if (name.endsWith(".snbt")) out.set(relative(root, p).split(sep).join("/"), readFileSync(p, "utf8"));
		}
	};
	walk(root);
	return out;
}

/** Lines that differ between two texts (simple LCS-free diff, enough for small edits). */
export function changedLines(a: string, b: string): { removed: string[]; added: string[] } {
	const al = a.split("\n");
	const bl = b.split("\n");
	let s = 0;
	while (s < al.length && s < bl.length && al[s] === bl[s]) s++;
	let ea = al.length - 1;
	let eb = bl.length - 1;
	while (ea >= s && eb >= s && al[ea] === bl[eb]) {
		ea--;
		eb--;
	}
	return { removed: al.slice(s, ea + 1), added: bl.slice(s, eb + 1) };
}
