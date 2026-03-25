import { getLogger } from "@logtape/logtape";

const logger = getLogger(["recall", "shutdown"]);

export interface ShutdownController {
	signal: AbortSignal;
	abort: () => void;
	isAborted: () => boolean;
	onShutdown: (fn: () => Promise<void>) => void;
	executeShutdown: () => Promise<void>;
}

let _controller: ShutdownController | null = null;

export function getShutdownController(): ShutdownController {
	if (!_controller) {
		const ac = new AbortController();
		const cleanups: (() => Promise<void>)[] = [];
		let executed = false;

		_controller = {
			signal: ac.signal,
			abort: () => ac.abort(),
			isAborted: () => ac.signal.aborted,
			onShutdown: (fn) => cleanups.push(fn),
			executeShutdown: async () => {
				if (executed) return;
				executed = true;
				for (const fn of cleanups.reverse()) {
					try {
						await fn();
					} catch {}
				}
			},
		};
	}
	return _controller;
}

export function installSignalHandlers(
	controller: ShutdownController,
	forceTimeoutMs: number,
): void {
	let signalCount = 0;

	const handler = (_signal: string) => {
		signalCount++;
		if (signalCount === 1) {
			logger.warn("Interrupt received, finishing current work...");
			controller.abort();
			setTimeout(() => {
				logger.warn("Shutdown timeout exceeded, force quitting");
				process.exit(1);
			}, forceTimeoutMs).unref();
		} else {
			logger.warn("Force quitting...");
			process.exit(1);
		}
	};

	process.on("SIGINT", () => handler("SIGINT"));
	process.on("SIGTERM", () => handler("SIGTERM"));
}
