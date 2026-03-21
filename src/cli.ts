#!/usr/bin/env bun
import { Command } from "commander";
import { analyzeCommand } from "./commands/analyze";
import { frustrationsCommand } from "./commands/frustrations";
import { ingestCommand } from "./commands/ingest";
import { projectsCommand } from "./commands/projects";
import { researchCommand } from "./commands/research";
import { searchCommand } from "./commands/search";
import { sessionsCommand } from "./commands/sessions";
import { showCommand } from "./commands/show";
import { statsCommand } from "./commands/stats";
import { toolsCommand } from "./commands/tools";
import { close } from "./db/index";

const program = new Command()
	.name("recall")
	.description("Query and analyze AI coding assistant session history")
	.version("0.1.0");

program.addCommand(ingestCommand);
program.addCommand(analyzeCommand);
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

program.parse();
