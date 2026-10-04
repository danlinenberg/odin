/**
 * A person's name as a chip. A list of ten people used to be ten solid
 * coloured pills, louder than the statuses beside them - so the chip is
 * neutral, and the person's colour is the dot and a faint wash behind it,
 * derived from the name so the same person is the same colour everywhere.
 */

// One lightness and chroma, eight hues around the wheel (OKLCH), so no
// person's dot is brighter than another's - just a different hue.
const HUES = [300, 155, 240, 55, 0, 195, 95, 270];

export function personColor(name: string): { fg: string } {
	let hash = 0;
	for (let i = 0; i < name.length; i++)
		hash = (hash * 31 + name.charCodeAt(i)) | 0;
	return { fg: `oklch(0.76 0.12 ${HUES[Math.abs(hash) % HUES.length]})` };
}

export function PersonChip({
	name,
	className,
}: {
	name: string;
	className?: string;
}) {
	const { fg } = personColor(name);
	return (
		<span
			className={`inline-flex min-w-0 items-center gap-1.5 rounded-[6px] bg-secondary px-[7px] py-[1px] text-[11px] font-medium text-soft-foreground ring-1 ring-inset ring-border ${className ?? ""}`}
			// A breath of the person's colour behind the dot, fading out before
			// the name - enough to tell people apart, not enough to shout.
			style={{
				backgroundImage: `linear-gradient(to right, color-mix(in oklab, ${fg} 18%, transparent), transparent 70%)`,
			}}
		>
			<span
				className="size-1.5 shrink-0 rounded-full"
				style={{ backgroundColor: fg, boxShadow: `0 0 5px ${fg}` }}
			/>
			{/* The name gives, not the chip: a long GitHub login gets an ellipsis
			    rather than being cut mid-word by the column edge. */}
			<span className="truncate">{name}</span>
		</span>
	);
}
