export function agoLabel(at: number): string {
	const minutes = Math.round((Date.now() - at) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d ago`;
	return new Date(at).toLocaleDateString();
}

export function repoLabel(cwd: string | null | undefined): string | null {
	return cwd ? (cwd.split("/").filter(Boolean).pop() ?? null) : null;
}
