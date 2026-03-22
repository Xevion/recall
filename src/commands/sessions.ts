import { Command } from "commander";
import { withDb } from "../db/index";
import type { SessionRow, SessionSearchRow } from "../db/queries";
import {
	getAvailableProjects,
	listSessions,
	searchSessions,
} from "../db/queries";
import {
	colorNumeric,
	colorOutcome,
	colorProject,
	colorSessionTypes,
	colorSource,
	colorStarted,
	colorStatus,
	projectDisplay,
} from "../utils/colors";
import { formatDate, formatDuration, formatTokens } from "../utils/format";
import { createTable, normalizeScores } from "../utils/table";
import { c } from "../utils/theme";

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

function parseSortBy(raw: string): { field: string; dir?: "asc" | "desc" } {
	const parts = raw.split("/");
	const field = resolveEnumOption(parts[0] ?? "", VALID_SORT_FIELDS, "sort-by");
	const dir = parts[1];
	if (dir) {
		resolveEnumOption(dir, ["asc", "desc"] as const, "sort-by direction");
	}
	return { field, dir: dir as "asc" | "desc" | undefined };
}

interface ColumnDef {
	name: string;
	align: "left" | "right" | "center";
	width: number;
	wideWidth?: number;
	value: (s: SessionRow, ctx: RenderContext) => string;
}

interface RenderContext {
	wide: boolean;
	relevanceMap?: Map<string, number>;
}

function buildColumns(
	sessions: SessionRow[],
	wide: boolean,
	hasRelevance: boolean,
	statusFilter?: string,
): ColumnDef[] {
	const uniformSource =
		sessions.length > 0 &&
		sessions.every((s) => s.source === sessions[0]!.source);
	const showStatus = !statusFilter;
	const showSource = !uniformSource;

	const cols: ColumnDef[] = [];

	cols.push({
		name: "ID",
		align: "left",
		width: 10,
		wideWidth: 38,
		value: (s) => c.overlay0(wide ? s.id : s.id.slice(0, 8)),
	});

	if (showSource) {
		cols.push({
			name: "Source",
			align: "left",
			width: 13,
			value: (s) => colorSource(s.source),
		});
	}

	cols.push({
		name: "Project",
		align: "left",
		width: 18,
		value: (s) => colorProject(projectDisplay(s)),
	});

	cols.push({
		name: "Started",
		align: "left",
		width: 18,
		wideWidth: 24,
		value: (s) => colorStarted(s.started_at, formatDate(s.started_at, wide)),
	});

	cols.push({
		name: "Msgs",
		align: "right",
		width: 6,
		value: (s) =>
			colorNumeric(s.message_count, 15, 42, 74, String(s.message_count ?? 0)),
	});

	cols.push({
		name: "Turns",
		align: "right",
		width: 7,
		value: (s) =>
			colorNumeric(s.turn_count, 2, 3, 7, String(s.turn_count ?? 0)),
	});

	cols.push({
		name: "Duration",
		align: "right",
		width: 10,
		value: (s) =>
			colorNumeric(s.duration_s, 202, 766, 1752, formatDuration(s.duration_s)),
	});

	cols.push({
		name: "Tokens",
		align: "right",
		width: 8,
		value: (s) => {
			const total = Number(s.token_input ?? 0) + Number(s.token_output ?? 0);
			return colorNumeric(total, 50_000, 200_000, 500_000, formatTokens(total));
		},
	});

	if (showStatus) {
		cols.push({
			name: "Status",
			align: "left",
			width: 14,
			value: (s) => colorStatus(s.analysis_status),
		});
	}

	if (wide) {
		cols.push({
			name: "Outcome",
			align: "left",
			width: 9,
			value: (s) => colorOutcome(s.outcome, s.outcome_confidence),
		});

		cols.push({
			name: "Types",
			align: "left",
			width: 20,
			value: (s) => colorSessionTypes(s.session_types),
		});
	}

	if (hasRelevance) {
		cols.push({
			name: "Rel",
			align: "right",
			width: 6,
			value: (s, ctx) => {
				const pct = ctx.relevanceMap?.get(s.id);
				return pct != null ? c.catGreen(`${pct}%`) : "";
			},
		});
	}

	// Summary always shown — wider in wide mode
	cols.push({
		name: "Summary",
		align: "left",
		width: 34,
		wideWidth: 50,
		value: (s) => {
			const maxLen = wide ? 48 : 32;
			const summary = s.summary
				? s.summary.length > maxLen
					? `${s.summary.slice(0, maxLen - 1)}…`
					: s.summary
				: "—";
			return s.summary ? c.subtext0(summary) : c.overlay0(summary);
		},
	});

	return cols;
}

function printAggregateFooter(sessions: SessionRow[]): void {
	const count = sessions.length;
	if (count === 0) {
		console.log(c.overlay0("  No sessions found."));
		return;
	}

	const totalDuration = sessions.reduce(
		(sum, s) => sum + Number(s.duration_s ?? 0),
		0,
	);
	const totalTokens = sessions.reduce(
		(sum, s) => sum + Number(s.token_input ?? 0) + Number(s.token_output ?? 0),
		0,
	);
	const totalTurns = sessions.reduce(
		(sum, s) => sum + Number(s.turn_count ?? 0),
		0,
	);

	const parts = [
		`${count} session${count === 1 ? "" : "s"}`,
		formatDuration(totalDuration),
		`${formatTokens(totalTokens)} tokens`,
		`${totalTurns} turns`,
	];

	console.log(c.overlay1(`\n${parts.join(c.surface1("  ·  "))}`));
}

function renderTable(
	sessions: SessionRow[],
	wide: boolean,
	relevanceMap?: Map<string, number>,
	statusFilter?: string,
): void {
	const hasRelevance = !!relevanceMap && relevanceMap.size > 0;
	const cols = buildColumns(sessions, wide, hasRelevance, statusFilter);

	const head = cols.map((col) => col.name);
	const colAligns = cols.map((col) => col.align);
	const colWidths = cols.map((col) =>
		wide && col.wideWidth ? col.wideWidth : col.width,
	);

	const table = createTable({ head, colAligns, colWidths });

	if (sessions.length === 0) {
		console.log(table.toString());
		console.log(c.overlay0("  No sessions found."));
		return;
	}

	const ctx: RenderContext = { wide, relevanceMap };
	for (const s of sessions) {
		table.push(cols.map((col) => col.value(s, ctx)));
	}

	console.log(table.toString());
	printAggregateFooter(sessions);
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
				const relevanceMap = normalizeScores(
					results.map((r) => ({ id: r.id, score: r.relevance })),
				);

				if (opts.json) {
					console.log(JSON.stringify(results, null, 2));
				} else {
					renderTable(results, !!opts.wide, relevanceMap, status);
				}
			} else {
				const sessions = await listSessions(db, listOpts);

				if (opts.json) {
					console.log(JSON.stringify(sessions, null, 2));
				} else {
					renderTable(sessions, !!opts.wide, undefined, status);
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
