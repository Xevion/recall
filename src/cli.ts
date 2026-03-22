#!/usr/bin/env bun
import { Command } from "commander";
import { analyzeCommand } from "./commands/analyze";
import { exportCommand } from "./commands/export";
import { frustrationsCommand } from "./commands/frustrations";
import { ftsCommand } from "./commands/fts";
import { ingestCommand } from "./commands/ingest";
import { projectsCommand } from "./commands/projects";
import { researchCommand } from "./commands/research";
import { searchCommand } from "./commands/search";
import { sessionsCommand } from "./commands/sessions";
import { showCommand } from "./commands/show";
import { statsCommand } from "./commands/stats";
import { toolsCommand } from "./commands/tools";
import { close } from "./db/index";
import { setupLogging, teardownLogging } from "./logging/setup";
import { ValidationError } from "./utils/validation";

const program = new Command()
	.name("recall")
	.description("Query and analyze AI coding assistant session history")
	.version("0.1.0")
	.option(
		"-v, --verbose",
		"Increase verbosity (-v, -vv, -vvv)",
		(_v, prev: number) => prev + 1,
		0,
	)
	.option("-q, --quiet", "Suppress non-essential output")
	.option("--log-file <path>", "Write JSONL logs to file")
	.hook("preAction", async (_thisCommand) => {
		const opts = program.opts();
		await setupLogging({
			verbosity: opts.verbose as number,
			quiet: !!opts.quiet,
			logFile: opts.logFile as string | undefined,
		});
	});

program.addCommand(ingestCommand);
program.addCommand(analyzeCommand);
program.addCommand(exportCommand);
program.addCommand(ftsCommand);
program.addCommand(sessionsCommand);
program.addCommand(showCommand);
program.addCommand(searchCommand);
program.addCommand(toolsCommand);
program.addCommand(frustrationsCommand);
program.addCommand(researchCommand);
program.addCommand(projectsCommand);
program.addCommand(statsCommand);

async function shutdown(): Promise<void> {
	await teardownLogging();
	await close();
	process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

program.parseAsync().catch(async (err) => {
	if (err instanceof ValidationError) {
		console.error(err.message);
		await teardownLogging();
		process.exit(1);
	}
	throw err;
});
