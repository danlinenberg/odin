/**
 * Every coloured pill's colours, in one place. The Night Agent look: a dark
 * gradient that leans into the neighbouring hue, a light label, and a soft
 * glow in the pill's own colour. Grey pills stay flat — a glow on a neutral
 * says nothing.
 *
 * Classes only: size, padding and weight stay with each pill.
 */
export const PILL = {
	night:
		"bg-gradient-to-r from-[#3b2a7a] to-[#1d4f7a] text-[#e4dcff] shadow-[0_0_6px_rgba(124,108,255,.45)]",
	violet:
		"bg-gradient-to-r from-[#4a2a86] to-[#6b2a78] text-[#efe6ff] shadow-[0_0_6px_rgba(163,148,255,.4)]",
	green:
		"bg-gradient-to-r from-[#155c35] to-[#11524a] text-[#d6fbe9] shadow-[0_0_6px_rgba(62,207,142,.4)]",
	teal: "bg-gradient-to-r from-[#0e4f55] to-[#163f72] text-[#d8faf0] shadow-[0_0_6px_rgba(126,224,161,.4)]",
	amber:
		"bg-gradient-to-r from-[#6e4a10] to-[#6e2f14] text-[#ffefcc] shadow-[0_0_6px_rgba(245,184,61,.4)]",
	red: "bg-gradient-to-r from-[#6e1f2c] to-[#5e1a4c] text-[#ffe0e5] shadow-[0_0_6px_rgba(240,100,122,.45)]",
	/** Louder than red: overdue is the one that has to win the row. */
	alarm:
		"bg-gradient-to-r from-[#771c2c] to-[#641848] text-[#ffe3e7] shadow-[0_0_6px_rgba(255,77,94,.47)]",
	pink: "bg-gradient-to-r from-[#6e2446] to-[#5c2470] text-[#ffe3ee] shadow-[0_0_6px_rgba(255,143,174,.4)]",
	blue: "bg-gradient-to-r from-[#1d4f7a] to-[#24357f] text-[#dcefff] shadow-[0_0_6px_rgba(126,196,255,.4)]",
} as const;
