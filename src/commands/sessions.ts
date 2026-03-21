import { Command } from "commander";
import { close, getDb } from "../db/index";
import { listSessions, type SessionRow } from "../db/queries";

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

// Catppuccin Mocha palette (truecolor)
const rgb = (r: number, g: number, b: number) => (s: string) =>
	`\x1b[38;2;${r};${g};${b}m${s}\x1b[39m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;

const cat = {
	rosewater: rgb(245, 224, 220),
	flamingo: rgb(242, 205, 205),
	pink: rgb(245, 194, 231),
	mauve: rgb(203, 166, 247),
	red: rgb(243, 139, 168),
	maroon: rgb(235, 160, 172),
	peach: rgb(250, 179, 135),
	yellow: rgb(249, 226, 175),
	green: rgb(166, 227, 161),
	teal: rgb(148, 226, 213),
	sky: rgb(137, 220, 235),
	sapphire: rgb(116, 199, 236),
	blue: rgb(137, 180, 250),
	lavender: rgb(180, 190, 254),
	text: rgb(205, 214, 244),
	subtext1: rgb(186, 194, 222),
	subtext0: rgb(166, 173, 200),
	overlay2: rgb(147, 153, 178),
	overlay1: rgb(127, 132, 156),
	overlay0: rgb(108, 112, 134),
	surface2: rgb(88, 91, 112),
	surface1: rgb(69, 71, 90),
	surface0: rgb(49, 50, 68),
};

// Bag of distinct project colors — stable per project name via hash
const PROJECT_COLORS = [
	cat.rosewater,
	cat.flamingo,
	cat.pink,
	cat.mauve,
	cat.peach,
	cat.yellow,
	cat.green,
	cat.teal,
	cat.sky,
	cat.sapphire,
	cat.blue,
	cat.lavender,
	cat.maroon,
];

function hashStr(s: string): number {
	let h = 0;
	for (let i = 0; i < s.length; i++) {
		h = Math.imul(31, h) + s.charCodeAt(i);
		h |= 0;
	}
	return Math.abs(h);
}

function colorProject(name: string): string {
	if (name === "—") return cat.overlay0(name);
	const idx = hashStr(name) % PROJECT_COLORS.length;
	const colorFn = PROJECT_COLORS[idx] ?? cat.text;
	return colorFn(name);
}

// Time-based coloring: future → very recent → old
function colorStarted(iso: string, formatted: string): string {
	const d = new Date(iso);
	const now = Date.now();
	const deltaMs = now - d.getTime();
	const deltaSec = deltaMs / 1000;

	if (deltaSec < 0) return cat.red(formatted); // future = error
	if (deltaSec < 300) return cat.green(formatted); // < 5 min
	if (deltaSec < 3600) return cat.teal(formatted); // < 1 hour
	if (deltaSec < 28800) return cat.sky(formatted); // < 8 hours
	if (deltaSec < 259200) return cat.blue(formatted); // < 3 days
	if (deltaSec < 604800) return cat.lavender(formatted); // < 7 days
	return cat.overlay1(formatted); // older
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

function colorStatus(status: string | null): string {
	if (!status) return cat.overlay0("—");
	switch (status) {
		case "complete":
			return cat.green(status);
		case "pending":
		case "retry_pending":
			return cat.yellow(status);
		case "processing":
			return cat.sapphire(status);
		case "skipped":
			return cat.overlay1(status);
		case "error":
			return cat.red(status);
		case "refused":
			return cat.maroon(status);
		default:
			return status;
	}
}

function colorSource(source: string): string {
	switch (source) {
		case "claude-code":
			return cat.overlay2(source);
		case "opencode":
			return cat.sapphire(source);
		default:
			return source;
	}
}

/** Color a numeric value based on percentile thresholds */
function colorByThresholds(
	val: number | null,
	p50: number,
	p75: number,
	p90: number,
): (s: string) => string {
	if (val == null || val === 0) return cat.overlay0;
	if (val < p50) return cat.subtext0;
	if (val < p75) return cat.teal;
	if (val < p90) return cat.peach;
	return cat.red;
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
	const diffMs = now.getTime() - d.getTime();
	const diffDays = Math.floor(diffMs / 86400000);
	if (diffDays === 0)
		return `Today ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
	if (diffDays === 1)
		return `Yesterday ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
	if (diffDays < 7) return `${diffDays}d ago`;
	return d.toLocaleDateString();
}

/** Extract the last meaningful directory name from a project path or name */
function projectDisplay(row: SessionRow): string {
	const raw = row.project_name ?? row.project_path;
	if (!raw) return "—";
	const cleaned = raw.replace(/\/+$/, "");
	const parts = cleaned.split("/");
	return parts[parts.length - 1] || cleaned;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escape codes
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function pad(str: string, width: number, align: "left" | "right"): string {
	const bare = str.replace(ANSI_RE, "");
	const padLen = Math.max(0, width - bare.length);
	if (align === "right") return " ".repeat(padLen) + str;
	return str + " ".repeat(padLen);
}

interface Column {
	header: string;
	width: number;
	align: "left" | "right";
	get: (row: SessionRow, wide: boolean) => string;
	color?: (row: SessionRow, val: string) => string;
}

const COLUMNS: Column[] = [
	{
		header: "ID",
		width: 16,
		align: "left",
		get: (r) => r.id.slice(0, 14),
		color: (_r, v) => cat.overlay0(v),
	},
	{
		header: "Source",
		width: 13,
		align: "left",
		get: (r) => r.source,
		color: (_r, v) => colorSource(v),
	},
	{
		header: "Project",
		width: 18,
		align: "left",
		get: (r) => projectDisplay(r),
		color: (_r, v) => colorProject(v),
	},
	{
		header: "Started",
		width: 18,
		align: "left",
		get: (r, wide) => formatDate(r.started_at, wide),
		color: (r, v) => colorStarted(r.started_at, v),
	},
	{
		header: "Messages",
		width: 10,
		align: "right",
		get: (r) => String(r.message_count ?? 0),
		color: (r, v) => colorByThresholds(r.message_count, 15, 42, 74)(v),
	},
	{
		header: "Turns",
		width: 7,
		align: "right",
		get: (r) => String(r.turn_count ?? 0),
		color: (r, v) => colorByThresholds(r.turn_count, 2, 3, 7)(v),
	},
	{
		header: "Duration",
		width: 10,
		align: "right",
		get: (r) => formatDuration(r.duration_s),
		color: (r, v) => colorByThresholds(r.duration_s, 202, 766, 1752)(v),
	},
	{
		header: "Status",
		width: 14,
		align: "left",
		get: (r) => r.analysis_status ?? "—",
		color: (_r, v) => colorStatus(v),
	},
];

const WIDE_COLUMNS: Column[] = [
	{
		header: "Summary",
		width: 50,
		align: "left",
		get: (r) => {
			if (!r.summary) return "—";
			return r.summary.length > 48 ? `${r.summary.slice(0, 47)}…` : r.summary;
		},
	},
];

function renderTable(sessions: SessionRow[], wide: boolean): void {
	const cols = wide ? [...COLUMNS, ...WIDE_COLUMNS] : COLUMNS;

	const headerLine = cols
		.map((c) => pad(cat.text(bold(c.header)), c.width, c.align))
		.join("  ");
	console.log(headerLine);
	console.log(cat.surface1(cols.map((c) => "─".repeat(c.width)).join("──")));

	if (sessions.length === 0) {
		console.log(cat.overlay0("  No sessions found."));
		return;
	}

	for (const s of sessions) {
		const cells = cols.map((c) => {
			const raw = c.get(s, wide);
			const colored = c.color ? c.color(s, raw) : raw;
			return pad(colored, c.width, c.align);
		});
		console.log(cells.join("  "));
	}

	console.log(cat.overlay1(`\n${sessions.length} session(s)`));
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
				cat.red(
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
