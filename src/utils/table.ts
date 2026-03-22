import type Table from "cli-table3";
import TableConstructor from "cli-table3";
import { BORDERLESS_CHARS, c } from "./theme";

interface TableConfig {
	head: string[];
	colAligns: Table.HorizontalAlignment[];
	colWidths?: number[];
}

export function createTable(config: TableConfig): Table.Table {
	return new TableConstructor({
		head: config.head.map((h) => c.text.bold(h)),
		colAligns: config.colAligns,
		...(config.colWidths ? { colWidths: config.colWidths } : {}),
		style: { head: [], border: [], "padding-left": 0, "padding-right": 0 },
		chars: BORDERLESS_CHARS,
	});
}

export function printFooter(count: number, label: string): void {
	console.log(c.overlay1(`\n${count} ${label}(s)`));
}

export function normalizeScores<
	T extends { id?: string; score?: number | null },
>(items: T[]): Map<string, number> {
	const scores = items
		.map((s) => s.score)
		.filter((s): s is number => s != null);
	const result = new Map<string, number>();
	if (scores.length === 0) return result;
	const min = Math.min(...scores);
	const max = Math.max(...scores);
	const range = max - min;
	for (const s of items) {
		if (s.id != null && s.score != null) {
			const pct =
				range === 0 ? 100 : Math.round(((max - s.score) / range) * 100);
			result.set(s.id, pct);
		}
	}
	return result;
}
