import { basename, resolve } from "node:path";

/**
 * Expand a leading `~/` to the user's home directory.
 * Only the leading tilde is replaced — a tilde elsewhere in the path is kept as-is.
 */
export function expandPath(p: string): string {
	if (p.startsWith("~/")) {
		const home = process.env.HOME;
		if (!home) throw new Error("HOME environment variable is not set");
		return resolve(home, p.slice(2));
	}
	return resolve(p);
}

/**
 * Derive a short, human-readable project name from an absolute directory path.
 *
 * - Strips $HOME prefix, then common project roots like `projects/`
 * - Falls back to the directory basename if no pattern matches
 * - Returns null for empty/null input
 */
export function extractProjectName(dirPath: string | null): string | null {
	if (!dirPath) return null;
	const home = process.env.HOME ?? "";

	let rel = dirPath;
	if (home && rel.startsWith(home)) {
		rel = rel.slice(home.length).replace(/^\/+/, "");
	}

	// Strip common project root prefixes
	const prefixes = ["projects/", "src/", "repos/", "code/", "work/"];
	for (const prefix of prefixes) {
		if (rel.startsWith(prefix)) {
			rel = rel.slice(prefix.length);
			break;
		}
	}

	// If we still have a meaningful relative path, use it; otherwise basename
	return rel || basename(dirPath) || null;
}
