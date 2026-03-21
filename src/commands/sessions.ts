import Table from "cli-table3";
import { Command } from "commander";
import { withDb } from "../db/index";
import type { SessionRow, SessionSearchRow } from "../db/queries";
import {
	getAvailableProjects,
	listSessions,
	searchSessions,
} from "../db/queries";
import { formatDate, formatDuration } from "../utils/format";
import { extractProjectName } from "../utils/path";
import { BORDERLESS_CHARS, c } from "../utils/theme";
import {
	parseIntOption,
	parseRelativeDate,
	resolveEnumOption,
	resolveSourceOption,
	suggestProject,
} from "../utils/validation";

const VALID_SORT_FIELDS = ["started", "duration", "turns", "messages"];
const VALID_STATUSES = [
	"pending",
	"processing",
	"complete",
	"skipped",
	"error",
	"refused",
	"retry_pending",
];

// Bag of distinct project colors — stable per project name via hash
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

function parseSortBy(raw: string): { field: string; dir?: "asc" | "desc" } {
	const parts = raw.split("/");
	const field = resolveEnumOption(parts[0] ?? "", VALID_SORT_FIELDS, "sort-by");
	const dir = parts[1];
	if (dir) {
		resolveEnumOption(dir, ["asc", "desc"] as const, "sort-by direction");
	}
	return { field, dir: dir as "asc" | "desc" | undefined };
}

function colorProject(name: string): string {
	if (name === "—") return c.overlay0(name);
	const idx = hashStr(name) % PROJECT_COLORS.length;
	const colorFn = PROJECT_COLORS[idx] ?? c.text;
	return colorFn(name);
}

function colorStarted(iso: string, formatted: string): string {
	const deltaSec = (Date.now() - new Date(iso).getTime()) / 1000;
	if (deltaSec < 0) return c.catRed(formatted);
	if (deltaSec < 300) return c.catGreen(formatted);
	if (deltaSec < 3600) return c.teal(formatted);
	if (deltaSec < 28800) return c.sky(formatted);
	if (deltaSec < 259200) return c.catBlue(formatted);
	if (deltaSec < 604800) return c.lavender(formatted);
	return c.overlay1(formatted);
}

function colorStatus(status: string | null): string {
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

function colorSource(source: string): string {
	switch (source) {
		case "claude-code":
			return c.overlay2(source);
		case "opencode":
			return c.sapphire(source);
		default:
			return source;
	}
}

function colorNumeric(
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

function projectDisplay(row: SessionRow): string {
	return extractProjectName(row.project_path) ?? row.project_name ?? "—";
}

function normalizeRelevance(sessions: SessionSearchRow[]): Map<string, number> {
	const scores = sessions.map((s) => s.relevance).filter((s) => s != null);
	const result = new Map<string, number>();
	if (scores.length === 0) return result;
	const min = Math.min(...scores);
	const max = Math.max(...scores);
	const range = max - min;
	for (const s of sessions) {
		if (s.relevance != null) {
			const pct =
				range === 0 ? 100 : Math.round(((max - s.relevance) / range) * 100);
			result.set(s.id, pct);
		}
	}
	return result;
}

function buildRow(
	s: SessionRow,
	wide: boolean,
	relevancePct?: number,
): string[] {
	const proj = projectDisplay(s);
	const date = formatDate(s.started_at, wide);
	const dur = formatDuration(s.duration_s);
	const msgs = String(s.message_count ?? 0);
	const turns = String(s.turn_count ?? 0);

	const idDisplay = wide ? s.id : s.id.slice(0, 14);
	const row = [
		c.overlay0(idDisplay),
		colorSource(s.source),
		colorProject(proj),
		colorStarted(s.started_at, date),
		colorNumeric(s.message_count, 15, 42, 74, msgs),
		colorNumeric(s.turn_count, 2, 3, 7, turns),
		colorNumeric(s.duration_s, 202, 766, 1752, dur),
		colorStatus(s.analysis_status),
	];

	if (relevancePct != null) {
		row.push(c.catGreen(`${relevancePct}%`));
	}

	if (wide) {
		const summary = s.summary
			? s.summary.length > 48
				? `${s.summary.slice(0, 47)}…`
				: s.summary
			: "—";
		row.push(s.summary ? c.subtext0(summary) : c.overlay0(summary));
	}

	return row;
}

function renderTable(
	sessions: SessionRow[],
	wide: boolean,
	relevanceMap?: Map<string, number>,
): void {
	const hasRelevance = relevanceMap && relevanceMap.size > 0;
	const head = [
		"ID",
		"Source",
		"Project",
		"Started",
		"Messages",
		"Turns",
		"Duration",
		"Status",
	];
	const colAligns: Table.HorizontalAlignment[] = [
		"left",
		"left",
		"left",
		"left",
		"right",
		"right",
		"right",
		"left",
	];
	const colWidths = wide
		? [38, 13, 18, 24, 10, 7, 10, 14]
		: [16, 13, 18, 18, 10, 7, 10, 14];

	if (hasRelevance) {
		head.push("Rel");
		colAligns.push("right");
		colWidths.push(6);
	}

	if (wide) {
		head.push("Summary");
		colAligns.push("left");
		colWidths.push(50);
	}

	const table = new Table({
		head: head.map((h) => c.text.bold(h)),
		colAligns,
		colWidths,
		style: { head: [], border: [], "padding-left": 0, "padding-right": 0 },
		chars: BORDERLESS_CHARS,
	});

	if (sessions.length === 0) {
		console.log(table.toString());
		console.log(c.overlay0("  No sessions found."));
		return;
	}

	for (const s of sessions) {
		const pct = hasRelevance ? relevanceMap.get(s.id) : undefined;
		table.push(buildRow(s, wide, pct));
	}

	console.log(table.toString());
	console.log(c.overlay1(`\n${sessions.length} session(s)`));
}

export const sessionsCommand = new Command("sessions")
	.description("List sessions")
	.option(
		"-q, --query <text>",
		"Full-text search across messages and summaries",
	)
	.option("-p, --project <name>", "Filter by project name")
	.option("-s, --source <type>", "Filter by source (claude-code, opencode)")
	.option("--since <date>", "Sessions after this date")
	.option("-l, --limit <n>", "Number of sessions to show", "20")
	.option(
		"--status <status>",
		`Filter by analysis status (${VALID_STATUSES.join(", ")})`,
	)
	.option("--min-turns <n>", "Minimum turn count")
	.option("--min-duration <n>", "Minimum duration in seconds")
	.option("--min-messages <n>", "Minimum message count")
	.option(
		"--sort-by <field>",
		`Sort by field (${VALID_SORT_FIELDS.join(", ")}), optional /asc or /desc suffix`,
	)
	.option("--asc", "Sort ascending")
	.option("--desc", "Sort descending")
	.option("-w, --wide", "Show expanded detail (summary, full timestamps)")
	.option("--json", "Output as JSON")
	.action(async (opts) => {
		let sortField: string | undefined;
		let sortDir: "asc" | "desc" | undefined;
		if (opts.sortBy) {
			const parsed = parseSortBy(opts.sortBy);
			sortField = parsed.field;
			sortDir = parsed.dir;
		}
		if (!sortDir) {
			if (opts.asc) sortDir = "asc";
			else if (opts.desc) sortDir = "desc";
		}

		const source = opts.source ? resolveSourceOption(opts.source) : undefined;
		const status = opts.status
			? resolveEnumOption(opts.status, VALID_STATUSES, "status")
			: undefined;
		const since = opts.since ? parseRelativeDate(opts.since) : undefined;
		const limit = parseIntOption(opts.limit, "limit");
		const minTurns = opts.minTurns
			? parseIntOption(opts.minTurns, "min-turns")
			: undefined;
		const minDuration = opts.minDuration
			? parseIntOption(opts.minDuration, "min-duration")
			: undefined;
		const minMessages = opts.minMessages
			? parseIntOption(opts.minMessages, "min-messages")
			: undefined;

		const listOpts = {
			project: opts.project,
			source,
			since,
			limit,
			status,
			minTurns,
			minDuration,
			minMessages,
			sortBy: sortField,
			sortDir,
		};

		await withDb(async (db) => {
			if (opts.query) {
				const results = await searchSessions(db, opts.query, listOpts);
				const relevanceMap = normalizeRelevance(results);

				if (opts.json) {
					console.log(JSON.stringify(results, null, 2));
				} else {
					renderTable(results, !!opts.wide, relevanceMap);
				}
			} else {
				const sessions = await listSessions(db, listOpts);

				if (opts.json) {
					console.log(JSON.stringify(sessions, null, 2));
				} else {
					renderTable(sessions, !!opts.wide);
					if (sessions.length === 0 && opts.project) {
						const available = await getAvailableProjects(db);
						const suggestions = suggestProject(opts.project, available);
						if (suggestions.length > 0) {
							console.log(
								c.overlay1(`  Did you mean: ${suggestions.join(", ")}?`),
							);
						}
					}
				}
			}
		});
	});
