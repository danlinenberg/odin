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
		"bg-gradient-to-r from-[#302460] to-[#1a4060] text-[#e4dcff] shadow-[0_0_4px_rgba(124,108,255,.32)]",
	violet:
		"bg-gradient-to-r from-[#3c246a] to-[#54245f] text-[#efe6ff] shadow-[0_0_4px_rgba(163,148,255,.28)]",
	green:
		"bg-gradient-to-r from-[#14492d] to-[#11423c] text-[#d6fbe9] shadow-[0_0_4px_rgba(62,207,142,.28)]",
	teal: "bg-gradient-to-r from-[#0f4045] to-[#15345a] text-[#d8faf0] shadow-[0_0_4px_rgba(126,224,161,.28)]",
	amber:
		"bg-gradient-to-r from-[#573c11] to-[#572814] text-[#ffefcc] shadow-[0_0_4px_rgba(245,184,61,.28)]",
	red: "bg-gradient-to-r from-[#571c26] to-[#4b183e] text-[#ffe0e5] shadow-[0_0_4px_rgba(240,100,122,.32)]",
	/** Louder than red: overdue is the one that has to win the row. */
	alarm:
		"bg-gradient-to-r from-[#7e1525] to-[#6c103b] text-[#fff1f3] shadow-[0_0_6px_rgba(255,77,94,.45)]",
	pink: "bg-gradient-to-r from-[#571f3a] to-[#491f59] text-[#ffe3ee] shadow-[0_0_4px_rgba(255,143,174,.28)]",
	blue: "bg-gradient-to-r from-[#1a4060] to-[#1f2c64] text-[#dcefff] shadow-[0_0_4px_rgba(126,196,255,.28)]",
} as const;
