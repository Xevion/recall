/** Parse an integer CLI option; throws a clear error if not a valid integer. */
export function parseIntOption(value: string, optionName = "value"): number {
	const n = Number.parseInt(value, 10);
	if (Number.isNaN(n)) {
		throw new Error(`--${optionName} must be an integer, got: ${JSON.stringify(value)}`);
	}
	return n;
}

/** Parse a date CLI option; throws if not a valid date string. */
export function parseDateOption(value: string, optionName = "value"): string {
	const d = new Date(value);
	if (Number.isNaN(d.getTime())) {
		throw new Error(`--${optionName} must be a valid date, got: ${JSON.stringify(value)}`);
	}
	return d.toISOString();
}

/** Validate an enum CLI option; throws if the value is not in the allowed set. */
export function parseEnumOption<T extends string>(
	value: string,
	allowed: readonly T[],
	optionName = "value",
): T {
	if (!(allowed as readonly string[]).includes(value)) {
		throw new Error(
			`--${optionName} must be one of: ${allowed.join(", ")}. Got: ${JSON.stringify(value)}`,
		);
	}
	return value as T;
}
