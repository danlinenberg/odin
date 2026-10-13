/**
 * Every coloured pill's colours, in one place, keyed by what the colour
 * means - not by hue - so a pill can't pick a colour for looks. The Graphite
 * look: a flat tint of the hue, the hue's ink as the label, and a hairline
 * edge in its own colour (glow-*). No gradients, no halos - the hue is the
 * signal. Neutral stays flat. The hues are the tokens in globals.css.
 *
 * Classes only: size, padding and weight stay with each pill.
 */
export const PILL = {
	/** Odin's own doing - Night Agent, auto-started, automations, merged.
	 *  Not a hue: an inked stamp, so it never reads as a status. */
	brand:
		"bg-foreground/[0.04] text-foreground ring-1 ring-inset ring-foreground/40",
	/** In flight - a running agent, a live session. */
	working: "bg-working/14 text-working-ink glow-working",
	/** Waiting on you, or about to be a problem. */
	attention: "bg-attention/14 text-attention-ink glow-attention",
	/** Finished, open, passing. */
	success: "bg-success/14 text-success-ink glow-success",
	/** Failed, high priority, over a limit. */
	danger: "bg-danger/14 text-danger-ink glow-danger",
	/** Louder than danger: overdue is the one that has to win the row. */
	alarm: "bg-danger text-background",
	/** A fact, not a flag. */
	neutral: "bg-secondary text-soft-foreground ring-1 ring-inset ring-border",
} as const;

/**
 * Button colours, the same way. A view gets one primary - the thing it exists
 * for - inked solid, and everything else is secondary, so the solid button
 * means "the next click" wherever you are. Done keeps its green: it's the one
 * action that is also a status. `selected` is the on-state of any tab, nav
 * item or toggle - a raised neutral, never a hue.
 */
export const BUTTON = {
	primary:
		"bg-primary text-primary-foreground shadow-[0_1px_2px_rgb(0_0_0/0.3)] hover:bg-primary/90",
	secondary:
		"bg-secondary text-soft-foreground ring-1 ring-inset ring-border hover:bg-accent hover:text-foreground",
	done: "bg-success/12 text-success-ink ring-1 ring-inset ring-success/30 hover:bg-success/20",
	remind:
		"bg-attention/12 text-attention-ink ring-1 ring-inset ring-attention/30 hover:bg-attention/20",
	selected: "bg-accent text-foreground ring-1 ring-inset ring-input",
} as const;
