import { resolve } from "node:path";

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
