import { Command } from "commander";
import { all, withDb } from "../db/index";
import { resolveSessionId } from "../db/queries";
import {
	colorProject,
	colorSource,
	colorStarted,
	colorStatus,
	projectDisplay,
} from "../utils/colors";
import {
	formatDate,
	formatDuration,
	formatTokens,
	termWidth,
	wordWrap,
} from "../utils/format";
import { c } from "../utils/theme";

interface SessionDetail {
	id: string;
	source: string;
	parent_id: string | null;
	project_path: string | null;
	project_name: string | null;
	git_branch: string | null;
	title: string | null;
	started_at: string;
	ended_at: string | null;
	message_count: number;
	turn_count: number;
	token_input: number;
	token_output: number;
	duration_s: number;
	source_path: string;
}

interface AnalysisDetail {
	session_id: string;
	status: string;
	summary: string | null;
	topics: string[] | null;
	frustrations: string[] | null;
	workflow_notes: string | null;
}

interface SubagentRow {
	id: string;
	title: string | null;
	message_count: number;
	turn_count: number;
}

interface ToolStatRow {
	tool_name: string;
	count: number;
	errors: number;
}

const LABEL_WIDTH = 12;
const INDENT = 2;
const PREFIX_WIDTH = INDENT + LABEL_WIDTH;

function kv(label: string, value: string): void {
	console.log(
		`${" ".repeat(INDENT)}${c.overlay1(label.padEnd(LABEL_WIDTH))}${value}`,
	);
}

function kvWrap(
	label: string,
	text: string,
	colorFn: (s: string) => string = (s) => s,
): void {
	const availWidth = Math.max(20, termWidth() - PREFIX_WIDTH);
	const indent = " ".repeat(PREFIX_WIDTH);
	const lines = wordWrap(text, availWidth);

	if (lines.length === 0) return;

	const prefix = `${" ".repeat(INDENT)}${c.overlay1(label.padEnd(LABEL_WIDTH))}`;
	const output = lines
		.map((l, i) =>
			i === 0 ? `${prefix}${colorFn(l)}` : `${indent}${colorFn(l)}`,
		)
		.join("\n");
	console.log(output);
}

function kvList(
	label: string,
	items: string[],
	colorFn: (s: string) => string = (s) => s,
	bullet = "•",
): void {
	const bulletPrefix = `${bullet} `;
	const bulletWidth = bulletPrefix.length;
	const availWidth = Math.max(20, termWidth() - PREFIX_WIDTH - bulletWidth);
	const indent = " ".repeat(PREFIX_WIDTH);
	const bulletIndent = " ".repeat(PREFIX_WIDTH + bulletWidth);

	for (let i = 0; i < items.length; i++) {
		const item = items[i]!;
		const lines = wordWrap(item, availWidth);
		for (let j = 0; j < lines.length; j++) {
			const line = lines[j]!;
			if (i === 0 && j === 0) {
				const prefix = `${" ".repeat(INDENT)}${c.overlay1(label.padEnd(LABEL_WIDTH))}`;
				console.log(`${prefix}${c.overlay0(bulletPrefix)}${colorFn(line)}`);
			} else if (j === 0) {
				console.log(`${indent}${c.overlay0(bulletPrefix)}${colorFn(line)}`);
			} else {
				console.log(`${bulletIndent}${colorFn(line)}`);
			}
		}
	}
}

export const showCommand = new Command("show")
	.description("Show detailed session info")
	.argument("<session-id>", "Session ID (or unique prefix)")
	.option("--json", "Output as JSON")
	.action(async (sessionId, opts) => {
		await withDb(async (db) => {
			const resolved = await resolveSessionId(db, sessionId);
			const [session] = await all<SessionDetail>(
				db,
				"SELECT * FROM session WHERE id = ?",
				resolved,
			);
			if (!session) {
				console.error(`Session not found: ${sessionId}`);
				process.exit(1);
			}

			const analysis = await all<AnalysisDetail>(
				db,
				"SELECT * FROM analysis WHERE session_id = ?",
				session.id,
			);
			const subagents = await all<SubagentRow>(
				db,
				"SELECT id, title, message_count, turn_count FROM session WHERE parent_id = ?",
				session.id,
			);
			const toolStats = await all<ToolStatRow>(
				db,
				`SELECT tool_name, COUNT(*) as count, SUM(CASE WHEN is_error THEN 1 ELSE 0 END) as errors
         FROM tool_call WHERE session_id = ? GROUP BY tool_name ORDER BY count DESC`,
				session.id,
			);

			if (opts.json) {
				console.log(
					JSON.stringify(
						{ session, analysis: analysis[0], subagents, toolStats },
						null,
						2,
					),
				);
			} else {
				const proj = projectDisplay(session);
				console.log(`${c.text.bold("Session")} ${c.overlay0(session.id)}`);
				kv("Source", colorSource(session.source));
				kv("Project", colorProject(proj));
				kv("Branch", c.subtext0(session.git_branch ?? "—"));
				kv(
					"Started",
					colorStarted(
						session.started_at,
						formatDate(session.started_at, true),
					),
				);
				kv("Duration", c.subtext0(formatDuration(session.duration_s)));
				kv(
					"Messages",
					`${c.subtext0(String(session.message_count))} messages, ${c.subtext0(String(session.turn_count))} turns`,
				);
				kv(
					"Tokens",
					`${c.overlay1(formatTokens(session.token_input))} in / ${c.overlay1(formatTokens(session.token_output))} out`,
				);

				const a = analysis[0];
				if (a) {
					console.log(`\n${c.text.bold("Analysis")} ${colorStatus(a.status)}`);
					if (a.summary) kvWrap("Summary", a.summary, c.subtext0);
					if (a.topics?.length)
						kvWrap("Topics", a.topics.join(", "), c.subtext0);
					if (a.frustrations?.length)
						kvList("Issues", a.frustrations, c.catYellow);
					if (a.workflow_notes) kvWrap("Notes", a.workflow_notes, c.subtext0);
				}

				if (subagents.length > 0) {
					console.log(
						`\n${c.text.bold("Subagents")} ${c.overlay1(`(${subagents.length})`)}`,
					);
					for (const sa of subagents) {
						console.log(
							`  ${c.overlay0(sa.id.slice(0, 14))} ${c.subtext0(sa.title ?? "untitled")} ${c.overlay0(`(${sa.message_count} msgs)`)}`,
						);
					}
				}

				if (toolStats.length > 0) {
					console.log(`\n${c.text.bold("Tool Usage")}`);
					for (const t of toolStats) {
						const errStr =
							t.errors > 0 ? ` ${c.catRed(`(${t.errors} errors)`)}` : "";
						console.log(
							`  ${c.text(t.tool_name.padEnd(20))} ${c.subtext0(String(t.count))}${errStr}`,
						);
					}
				}
			}
		});
	});
