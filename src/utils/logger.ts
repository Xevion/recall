let _verbose = false;
let _quiet = false;

export function setVerbose(value: boolean): void {
	_verbose = value;
}

export function setQuiet(value: boolean): void {
	_quiet = value;
}

/** Normal output — suppressed by --quiet. */
export function log(msg: string): void {
	if (!_quiet) console.log(msg);
}

/** Verbose-only output — requires --verbose and no --quiet. */
export function debug(msg: string): void {
	if (_verbose && !_quiet) console.log(msg);
}

/** Warning output — always shown (not suppressed by --quiet). */
export function warn(msg: string): void {
	console.warn(msg);
}

/** Error output — always shown. */
export function error(msg: string): void {
	console.error(msg);
}
