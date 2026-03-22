let _verbosity = 0;
let _quiet = false;

export function setVerbosity(level: number): void {
	_verbosity = level;
}

export function setQuiet(quiet: boolean): void {
	_quiet = quiet;
}

export function verbosity(): number {
	return _verbosity;
}

export function isQuiet(): boolean {
	return _quiet;
}

/** Normal output — shown unless --quiet is set. */
export function log(msg: string): void {
	if (!_quiet) console.log(msg);
}

/** Verbose output — shown at -v (level >= 1). */
export function debug(msg: string): void {
	if (_verbosity >= 1 && !_quiet) console.error(`[debug] ${msg}`);
}

/** Trace output — shown at -vv (level >= 2). */
export function trace(msg: string): void {
	if (_verbosity >= 2 && !_quiet) console.error(`[trace] ${msg}`);
}

/** Warning output — shown on stderr unless --quiet is set. */
export function warn(msg: string): void {
	if (!_quiet) console.warn(`[warn] ${msg}`);
}

/** Error output — always shown on stderr. */
export function error(msg: string): void {
	console.error(`[error] ${msg}`);
}
