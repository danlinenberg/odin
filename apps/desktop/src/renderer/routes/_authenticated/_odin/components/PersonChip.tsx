/**
 * A colored chip for a person's name. Color is derived from the name so the
 * same person is always the same color across the Tasks view and Dev Board.
 */

// Dark-bg / bright-fg pairs — vivid but readable on the near-black UI.
const PALETTE: { bg: string; fg: string }[] = [
	{ bg: "#2a1e3d", fg: "#c4a3ff" }, // violet
	{ bg: "#0f2e26", fg: "#4ade80" }, // green
	{ bg: "#0e2740", fg: "#5eb0ff" }, // blue
	{ bg: "#3a2416", fg: "#ff9f5e" }, // orange
	{ bg: "#3a1a28", fg: "#ff7ba3" }, // pink
	{ bg: "#0e2e33", fg: "#4fd4e0" }, // cyan
	{ bg: "#31300f", fg: "#e0d24f" }, // yellow
	{ bg: "#301a1a", fg: "#ff8080" }, // red
	{ bg: "#1a2e1a", fg: "#9fe080" }, // lime
	{ bg: "#16283a", fg: "#7ec4ff" }, // sky
];

export function personColor(name: string): { bg: string; fg: string } {
	let hash = 0;
	for (let i = 0; i < name.length; i++)
		hash = (hash * 31 + name.charCodeAt(i)) | 0;
	return PALETTE[Math.abs(hash) % PALETTE.length];
}

export function PersonChip({
	name,
	className,
}: {
	name: string;
	className?: string;
}) {
	const { bg, fg } = personColor(name);
	return (
		<span
			className={`inline-flex min-w-0 items-center gap-1 rounded-[6px] px-[7px] py-[1px] text-[11px] font-semibold ${className ?? ""}`}
			style={{ backgroundColor: bg, color: fg }}
		>
			<span
				className="size-1.5 shrink-0 rounded-full"
				style={{ backgroundColor: fg }}
			/>
			{/* The name gives, not the chip: a long GitHub login gets an ellipsis
			    rather than being cut mid-word by the column edge. */}
			<span className="truncate">{name}</span>
		</span>
	);
}
