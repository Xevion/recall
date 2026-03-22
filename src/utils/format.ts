export function formatDuration(seconds: number | null): string {
	if (seconds == null) return "—";
	if (seconds < 60) return `${seconds}s`;
	const m = Math.floor(seconds / 60);
	const s = seconds % 60;
	if (m < 60) return `${m}m${s > 0 ? ` ${s}s` : ""}`;
	const h = Math.floor(m / 60);
	const rm = m % 60;
	return `${h}h${rm > 0 ? ` ${rm}m` : ""}`;
}

export function formatDate(iso: string, wide = false): string {
	const d = new Date(iso);
	if (wide) return d.toLocaleString();
	const now = new Date();
	const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);
	if (diffDays === 0)
		return `Today ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
	if (diffDays === 1)
		return `Yesterday ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
	if (diffDays < 7) return `${diffDays}d ago`;
	if (diffDays < 14) return "1w ago";
	if (diffDays < 21) return "2w ago";
	if (diffDays < 28) return "3w ago";
	const months = [
		"Jan",
		"Feb",
		"Mar",
		"Apr",
		"May",
		"Jun",
		"Jul",
		"Aug",
		"Sep",
		"Oct",
		"Nov",
		"Dec",
	];
	const month = months[d.getMonth()];
	if (d.getFullYear() === now.getFullYear()) return `${month} ${d.getDate()}`;
	return `${month} ${d.getDate()}, ${d.getFullYear()}`;
}

export function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

export function termWidth(): number {
	return process.stdout.columns || 80;
}

export function wordWrap(text: string, width: number): string[] {
	const lines: string[] = [];
	const paragraphs = text.split("\n");

	for (const para of paragraphs) {
		const trimmed = para.trim();
		if (trimmed.length === 0) {
			lines.push("");
			continue;
		}
		const words = trimmed.split(/\s+/);
		let line = "";
		for (const word of words) {
			if (line.length > 0 && line.length + 1 + word.length > width) {
				lines.push(line);
				line = word;
			} else {
				line = line ? `${line} ${word}` : word;
			}
		}
		if (line) lines.push(line);
	}

	return lines;
}
