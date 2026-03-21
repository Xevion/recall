let _verbosity = 0;

export function setVerbosity(level: number): void {
	_verbosity = level;
}

export function verbosity(): number {
	return _verbosity;
}

/** Normal output — always shown unless piped to /dev/null. */
export function log(msg: string): void {
	console.log(msg);
}

/** Verbose output — shown at -v (level >= 1). */
export function debug(msg: string): void {
	if (_verbosity >= 1) console.error(`[debug] ${msg}`);
}

/** Trace output — shown at -vv (level >= 2). */
export function trace(msg: string): void {
	if (_verbosity >= 2) console.error(`[trace] ${msg}`);
}

/** Warning output — always shown on stderr. */
export function warn(msg: string): void {
	console.warn(`[warn] ${msg}`);
}

/** Error output — always shown on stderr. */
export function error(msg: string): void {
	console.error(`[error] ${msg}`);
}
