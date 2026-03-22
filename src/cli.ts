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
import { setQuiet, setVerbosity } from "./utils/logger";
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
	.hook("preAction", (_thisCommand) => {
		const opts = program.opts();
		setVerbosity(opts.verbose as number);
		if (opts.quiet) setQuiet(true);
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

// Graceful shutdown: close the DuckDB connection before exit.
async function shutdown(): Promise<void> {
	await close();
	process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

program.parseAsync().catch((err) => {
	if (err instanceof ValidationError) {
		console.error(err.message);
		process.exit(1);
	}
	throw err;
});
