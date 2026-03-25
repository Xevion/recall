export interface PoolOptions<T> {
	signal?: AbortSignal;
	delayMs?: number;
	onTaskComplete?: (result: PoolResult<T>, index: number) => boolean;
}

export interface PoolResult<T> {
	status: "ok" | "error" | "skipped";
	value?: T;
	error?: unknown;
}

export async function runPool<T>(
	tasks: (() => Promise<T>)[],
	concurrency: number,
	options?: PoolOptions<T>,
): Promise<PoolResult<T>[]> {
	const { signal, delayMs, onTaskComplete } = options ?? {};
	const results: PoolResult<T>[] = Array.from({ length: tasks.length }, () => ({
		status: "skipped" as const,
	}));

	let taskIndex = 0;
	let activeCount = 0;
	let shouldDispatch = true;
	const waiters: (() => void)[] = [];

	function notifyWaiter(): void {
		const waiter = waiters.shift();
		if (waiter) waiter();
	}

	function waitForSlot(): Promise<void> {
		return new Promise<void>((resolve) => {
			waiters.push(resolve);
		});
	}

	function dispatch(idx: number): void {
		activeCount++;
		const task = tasks[idx] as () => Promise<T>;
		task().then(
			(value) => {
				results[idx] = { status: "ok", value };
				if (onTaskComplete && !onTaskComplete(results[idx], idx)) {
					shouldDispatch = false;
				}
				activeCount--;
				notifyWaiter();
			},
			(error) => {
				results[idx] = { status: "error", error };
				if (onTaskComplete && !onTaskComplete(results[idx], idx)) {
					shouldDispatch = false;
				}
				activeCount--;
				notifyWaiter();
			},
		);
	}

	while (taskIndex < tasks.length) {
		if (!shouldDispatch || signal?.aborted) break;
		if (activeCount >= concurrency) {
			await waitForSlot();
			continue;
		}
		if (delayMs && taskIndex > 0) {
			await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
		}
		dispatch(taskIndex++);
	}

	// Drain: wait for all running tasks to complete
	while (activeCount > 0) {
		await waitForSlot();
	}

	return results;
}
