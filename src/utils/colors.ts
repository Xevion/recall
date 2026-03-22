import { extractProjectName } from "./path";
import { c } from "./theme";

const PROJECT_COLORS = [
	c.rosewater,
	c.flamingo,
	c.pink,
	c.mauve,
	c.peach,
	c.catYellow,
	c.catGreen,
	c.teal,
	c.sky,
	c.sapphire,
	c.catBlue,
	c.lavender,
	c.maroon,
];

function hashStr(s: string): number {
	let h = 0;
	for (let i = 0; i < s.length; i++) {
		h = Math.imul(31, h) + s.charCodeAt(i);
		h |= 0;
	}
	return Math.abs(h);
}

export function colorProject(name: string): string {
	if (name === "—") return c.overlay0(name);
	const idx = hashStr(name) % PROJECT_COLORS.length;
	const colorFn = PROJECT_COLORS[idx] ?? c.text;
	return colorFn(name);
}

export function colorStarted(iso: string, formatted: string): string {
	const deltaSec = (Date.now() - new Date(iso).getTime()) / 1000;
	if (deltaSec < 0) return c.catRed(formatted);
	if (deltaSec < 300) return c.catGreen(formatted);
	if (deltaSec < 3600) return c.teal(formatted);
	if (deltaSec < 28800) return c.sky(formatted);
	if (deltaSec < 259200) return c.catBlue(formatted);
	if (deltaSec < 604800) return c.lavender(formatted);
	return c.overlay1(formatted);
}

export function colorStatus(status: string | null): string {
	if (!status) return c.overlay0("—");
	switch (status) {
		case "complete":
			return c.catGreen(status);
		case "pending":
		case "retry_pending":
			return c.catYellow(status);
		case "processing":
			return c.sapphire(status);
		case "skipped":
			return c.overlay1(status);
		case "error":
			return c.catRed(status);
		case "refused":
			return c.maroon(status);
		default:
			return status;
	}
}

export function colorSource(source: string): string {
	switch (source) {
		case "claude-code":
			return c.overlay2(source);
		case "opencode":
			return c.sapphire(source);
		default:
			return source;
	}
}

export function colorNumeric(
	val: number | null,
	p50: number,
	p75: number,
	p90: number,
	formatted: string,
): string {
	if (val == null || val === 0) return c.overlay0(formatted);
	if (val < p50) return c.subtext0(formatted);
	if (val < p75) return c.teal(formatted);
	if (val < p90) return c.peach(formatted);
	return c.catRed(formatted);
}

export function projectDisplay(row: {
	project_path: string | null;
	project_name?: string | null;
}): string {
	return extractProjectName(row.project_path) ?? row.project_name ?? "—";
}
