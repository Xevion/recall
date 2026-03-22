import { resolve } from "node:path";
import { parse } from "smol-toml";

export interface RecallConfig {
	database: {
		path: string;
	};
	sources: {
		[key: string]: {
			enabled: boolean;
			path: string;
		};
	};
	analyze: {
		parallelism: number;
		delay_ms: number;
		model: string;
		inactivity_timeout_ms: number;
		max_consecutive_failures: number;
		max_retries: number;
		triage: {
			parent_thresholds: {
				min_messages: number;
				min_turns: number;
				min_duration_s: number;
				require_tool_calls: boolean;
			};
			subagent_thresholds: {
				min_messages: number;
				min_turns: number;
				min_duration_s: number;
				require_tool_calls: boolean;
			};
			auto_analyze_if_subagents: boolean;
			auto_analyze_min_turns: number;
			auto_analyze_if_errors: boolean;
			auto_analyze_min_duration_s: number;
		};
		research: {
			prompt_signals: string[];
		};
	};
	output: {
		default_format: "table" | "json" | "csv";
		page_size: number;
	};
}

const DEFAULT_CONFIG: RecallConfig = {
	database: {
		path: "~/.local/share/recall/recall.db",
	},
	sources: {
		"claude-code": {
			enabled: true,
			path: "~/.claude/projects",
		},
		opencode: {
			enabled: true,
			path: "~/.local/share/opencode/opencode.db",
		},
	},
	analyze: {
		parallelism: 3,
		delay_ms: 2000,
		model: "claude-sonnet-4-6",
		inactivity_timeout_ms: 30000,
		max_consecutive_failures: 5,
		max_retries: 3,
		triage: {
			parent_thresholds: {
				min_messages: 8,
				min_turns: 3,
				min_duration_s: 45,
				require_tool_calls: true,
			},
			subagent_thresholds: {
				min_messages: 6,
				min_turns: 1,
				min_duration_s: 30,
				require_tool_calls: true,
			},
			auto_analyze_if_subagents: true,
			auto_analyze_min_turns: 10,
			auto_analyze_if_errors: true,
			auto_analyze_min_duration_s: 300,
		},
		research: {
			prompt_signals: [
				"research",
				"explore",
				"evaluate",
				"compare",
				"find options",
				"look up",
				"search for",
				"alternatives",
				"investigate options",
				"what libraries",
				"how does .* work",
			],
		},
	},
	output: {
		default_format: "table",
		page_size: 20,
	},
};

let _config: RecallConfig | null = null;

function configPath(): string {
	const xdgData =
		process.env.XDG_DATA_HOME ||
		resolve(process.env.HOME ?? "", ".local/share");
	return resolve(xdgData, "recall", "config.toml");
}

export async function loadConfig(): Promise<RecallConfig> {
	if (_config) return _config;

	const path = configPath();
	const file = Bun.file(path);

	if (await file.exists()) {
		const text = await file.text();
		const parsed = parse(text) as unknown as Partial<RecallConfig>;
		// Deep merge with defaults
		_config = deepMerge(
			DEFAULT_CONFIG as unknown as Record<string, unknown>,
			parsed as unknown as Record<string, unknown>,
		) as unknown as RecallConfig;
	} else {
		_config = DEFAULT_CONFIG;
	}

	return _config;
}

function deepMerge(
	target: Record<string, unknown>,
	source: Record<string, unknown>,
): Record<string, unknown> {
	const result = { ...target };
	for (const key of Object.keys(source)) {
		if (
			source[key] &&
			typeof source[key] === "object" &&
			!Array.isArray(source[key]) &&
			target[key] &&
			typeof target[key] === "object"
		) {
			result[key] = deepMerge(
				target[key] as Record<string, unknown>,
				source[key] as Record<string, unknown>,
			);
		} else {
			result[key] = source[key];
		}
	}
	return result;
}
