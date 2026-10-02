/**
 * Every coloured pill's colours, in one place, keyed by what the colour
 * means — not by hue — so a pill can't pick a colour for looks. A flat tint
 * of the hue, the hue as text, and a hairline ring in it: no gradients, no
 * glow. The hues are the semantic tokens in globals.css.
 *
 * Classes only: size, padding and weight stay with each pill.
 */
export const PILL = {
	/** Odin's own doing — Night Agent, auto-started, merged. */
	brand: "bg-primary/12 text-primary ring-1 ring-inset ring-primary/20",
	/** In flight. */
	working: "bg-working/12 text-working ring-1 ring-inset ring-working/20",
	/** Waiting on you, or about to be a problem. */
	attention:
		"bg-attention/12 text-attention ring-1 ring-inset ring-attention/20",
	/** Finished, open, passing, live. */
	success: "bg-success/12 text-success ring-1 ring-inset ring-success/20",
	/** Failed, high priority, over a limit. */
	danger: "bg-danger/12 text-danger ring-1 ring-inset ring-danger/20",
	/** Louder than danger: overdue is the one that has to win the row. */
	alarm: "bg-danger/25 text-danger ring-1 ring-inset ring-danger/50",
	/** A fact, not a flag. */
	neutral: "bg-secondary text-soft-foreground ring-1 ring-inset ring-border",
} as const;

/**
 * Button colours, the same way. A view gets one primary — the thing it exists
 * for — and everything else is secondary, so violet means "the next click"
 * wherever you are. Done keeps its green: it's the one action that is also a
 * status.
 */
export const BUTTON = {
	primary: "bg-primary text-primary-foreground hover:bg-primary/90",
	secondary:
		"bg-secondary text-soft-foreground ring-1 ring-inset ring-border hover:bg-accent hover:text-foreground",
	done: "bg-success/12 text-success ring-1 ring-inset ring-success/20 hover:bg-success/20",
} as const;
