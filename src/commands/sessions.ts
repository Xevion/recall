import Table from "cli-table3";
import { Command } from "commander";
import { close, getDb } from "../db/index";
import type { SessionRow } from "../db/queries";
import { listSessions } from "../db/queries";
import { BORDERLESS_CHARS, c } from "../utils/theme";

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
	const field = parts[0] ?? "";
	const dir = parts[1];
	if (!VALID_SORT_FIELDS.includes(field)) {
		throw new Error(
			`Invalid sort field "${field}". Valid: ${VALID_SORT_FIELDS.join(", ")}`,
		);
	}
	if (dir && dir !== "asc" && dir !== "desc") {
		throw new Error(`Invalid sort direction "${dir}". Use "asc" or "desc".`);
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

function formatDuration(seconds: number | null): string {
	if (seconds == null) return "—";
	if (seconds < 60) return `${seconds}s`;
	const m = Math.floor(seconds / 60);
	const s = seconds % 60;
	if (m < 60) return `${m}m${s > 0 ? ` ${s}s` : ""}`;
	const h = Math.floor(m / 60);
	const rm = m % 60;
	return `${h}h${rm > 0 ? ` ${rm}m` : ""}`;
}

function formatDate(iso: string, wide: boolean): string {
	const d = new Date(iso);
	if (wide) return d.toLocaleString();
	const now = new Date();
	const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);
	if (diffDays === 0)
		return `Today ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
	if (diffDays === 1)
		return `Yesterday ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
	if (diffDays < 7) return `${diffDays}d ago`;
	return d.toLocaleDateString();
}

function projectDisplay(row: SessionRow): string {
	const raw = row.project_name ?? row.project_path;
	if (!raw) return "—";
	const cleaned = raw.replace(/\/+$/, "");
	const parts = cleaned.split("/");
	return parts[parts.length - 1] || cleaned;
}

function buildRow(s: SessionRow, wide: boolean): string[] {
	const proj = projectDisplay(s);
	const date = formatDate(s.started_at, wide);
	const dur = formatDuration(s.duration_s);
	const msgs = String(s.message_count ?? 0);
	const turns = String(s.turn_count ?? 0);

	const row = [
		c.overlay0(s.id.slice(0, 14)),
		colorSource(s.source),
		colorProject(proj),
		colorStarted(s.started_at, date),
		colorNumeric(s.message_count, 15, 42, 74, msgs),
		colorNumeric(s.turn_count, 2, 3, 7, turns),
		colorNumeric(s.duration_s, 202, 766, 1752, dur),
		colorStatus(s.analysis_status),
	];

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

function renderTable(sessions: SessionRow[], wide: boolean): void {
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
	const colWidths = [16, 13, 18, 18, 10, 7, 10, 14];

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
		table.push(buildRow(s, wide));
	}

	console.log(table.toString());
	console.log(c.overlay1(`\n${sessions.length} session(s)`));
}

export const sessionsCommand = new Command("sessions")
	.description("List sessions")
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

		if (opts.status && !VALID_STATUSES.includes(opts.status)) {
			console.error(
				c.catRed(
					`Invalid status "${opts.status}". Valid: ${VALID_STATUSES.join(", ")}`,
				),
			);
			process.exit(1);
		}

		const db = await getDb();
		try {
			const sessions = await listSessions(db, {
				project: opts.project,
				source: opts.source,
				since: opts.since,
				limit: Number.parseInt(opts.limit, 10),
				status: opts.status,
				minTurns: opts.minTurns
					? Number.parseInt(opts.minTurns, 10)
					: undefined,
				minDuration: opts.minDuration
					? Number.parseInt(opts.minDuration, 10)
					: undefined,
				minMessages: opts.minMessages
					? Number.parseInt(opts.minMessages, 10)
					: undefined,
				sortBy: sortField,
				sortDir,
			});

			if (opts.json) {
				console.log(JSON.stringify(sessions, null, 2));
			} else {
				renderTable(sessions, !!opts.wide);
			}
		} finally {
			await close();
		}
	});
