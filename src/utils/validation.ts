/** Thrown by validation functions for clean CLI error output. */
export class ValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ValidationError";
	}
}

/** Parse an integer CLI option; throws a clear error if not a valid integer. */
export function parseIntOption(value: string, optionName = "value"): number {
	const n = Number.parseInt(value, 10);
	if (Number.isNaN(n)) {
		throw new ValidationError(
			`--${optionName} must be an integer, got: ${JSON.stringify(value)}`,
		);
	}
	return n;
}

/**
 * Resolve an enum CLI option with prefix matching.
 * - Exact match (case-insensitive) first
 * - Unambiguous prefix match second
 * - Ambiguous prefix → error listing matches
 * - No match → error listing all valid options
 */
export function resolveEnumOption<T extends string>(
	value: string,
	allowed: readonly T[],
	optionName = "value",
): T {
	const lower = value.toLowerCase();

	// Exact match (case-insensitive)
	const exact = allowed.find((a) => a.toLowerCase() === lower);
	if (exact) return exact;

	// Prefix match
	const prefixMatches = allowed.filter((a) =>
		a.toLowerCase().startsWith(lower),
	);
	if (prefixMatches.length === 1) return prefixMatches[0]!;
	if (prefixMatches.length > 1) {
		throw new ValidationError(
			`--${optionName} "${value}" is ambiguous: ${prefixMatches.join(", ")}`,
		);
	}

	throw new ValidationError(
		`--${optionName} must be one of: ${allowed.join(", ")}. Got: ${JSON.stringify(value)}`,
	);
}

const SOURCE_ALIASES: Record<string, "claude-code" | "opencode"> = {
	cc: "claude-code",
	claude: "claude-code",
	"claude-code": "claude-code",
	oc: "opencode",
	opencode: "opencode",
};

const VALID_SOURCES = ["claude-code", "opencode"] as const;

/**
 * Resolve a source option with aliases.
 * Accepts: cc, claude, claude-code, oc, opencode (plus prefix matching).
 */
export function resolveSourceOption(value: string): "claude-code" | "opencode" {
	const alias = SOURCE_ALIASES[value.toLowerCase()];
	if (alias) return alias;

	// Fall through to prefix matching on canonical names
	try {
		return resolveEnumOption(value, VALID_SOURCES, "source");
	} catch {
		throw new ValidationError(
			`--source must be one of: ${VALID_SOURCES.join(", ")} (aliases: cc, claude, oc). Got: ${JSON.stringify(value)}`,
		);
	}
}

const RELATIVE_DATE_RE = /^(\d+)([dwmy])$/;

/**
 * Parse a date CLI option with support for relative shortcuts.
 * Supports: today, yesterday, Nd, Nw, Nm, Ny (e.g., 3d, 1w, 2m)
 * Falls back to Date constructor for ISO/date strings.
 */
export function parseRelativeDate(value: string, optionName = "since"): string {
	const lower = value.toLowerCase().trim();
	const now = new Date();

	if (lower === "today") {
		const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
		return d.toISOString();
	}
	if (lower === "yesterday") {
		const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
		return d.toISOString();
	}

	const match = RELATIVE_DATE_RE.exec(lower);
	if (match) {
		const amount = Number.parseInt(match[1]!, 10);
		const unit = match[2]!;
		const d = new Date(now);
		switch (unit) {
			case "d":
				d.setDate(d.getDate() - amount);
				break;
			case "w":
				d.setDate(d.getDate() - amount * 7);
				break;
			case "m":
				d.setMonth(d.getMonth() - amount);
				break;
			case "y":
				d.setFullYear(d.getFullYear() - amount);
				break;
		}
		return d.toISOString();
	}

	// Fall back to Date constructor
	const d = new Date(value);
	if (Number.isNaN(d.getTime())) {
		throw new ValidationError(
			`--${optionName} must be a valid date. Examples: 3d, 1w, 2m, yesterday, today, 2025-01-01. Got: ${JSON.stringify(value)}`,
		);
	}
	return d.toISOString();
}

/**
 * Suggest project names matching the user's input.
 * Returns up to 5 substring matches (case-insensitive).
 */
export function suggestProject(input: string, available: string[]): string[] {
	const lower = input.toLowerCase();
	return available.filter((p) => p.toLowerCase().includes(lower)).slice(0, 5);
}
