import { Command } from "commander";
import { ingestCommand } from "./commands/ingest";
import { analyzeCommand } from "./commands/analyze";
import { sessionsCommand } from "./commands/sessions";
import { showCommand } from "./commands/show";
import { searchCommand } from "./commands/search";
import { toolsCommand } from "./commands/tools";
import { frustrationsCommand } from "./commands/frustrations";
import { researchCommand } from "./commands/research";
import { projectsCommand } from "./commands/projects";
import { statsCommand } from "./commands/stats";

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

program.parse();
