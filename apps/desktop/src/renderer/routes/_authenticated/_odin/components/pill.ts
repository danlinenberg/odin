/**
 * Every coloured pill's colours, in one place, keyed by what the colour
 * means — not by hue — so a pill can't pick a colour for looks. The Night
 * Agent look: a gradient that leans into the neighbouring hue, the hue's
 * light ink as the label, and a soft glow in its own colour. Neutral stays
 * flat — a glow on grey says nothing. The hues are the tokens in globals.css.
 *
 * Classes only: size, padding and weight stay with each pill.
 */
export const PILL = {
	/** Odin's own doing — Night Agent, auto-started, automations, merged. */
	brand:
		"bg-gradient-to-r from-primary/30 to-working/15 text-primary-ink glow-primary",
	/** In flight — a running agent, a live session. */
	working:
		"bg-gradient-to-r from-working/30 to-primary/15 text-working-ink glow-working",
	/** Waiting on you, or about to be a problem. */
	attention:
		"bg-gradient-to-r from-attention/30 to-danger/12 text-attention-ink glow-attention",
	/** Finished, open, passing. */
	success:
		"bg-gradient-to-r from-success/28 to-working/12 text-success-ink glow-success",
	/** Failed, high priority, over a limit. */
	danger:
		"bg-gradient-to-r from-danger/30 to-primary/12 text-danger-ink glow-danger",
	/** Louder than danger: overdue is the one that has to win the row. */
	alarm:
		"bg-gradient-to-r from-danger/55 to-danger/30 text-white shadow-[0_0_8px_color-mix(in_oklab,var(--danger)_45%,transparent)]",
	/** A fact, not a flag. */
	neutral: "bg-secondary text-soft-foreground ring-1 ring-inset ring-border",
} as const;

/**
 * Button colours, the same way. A view gets one primary — the thing it exists
 * for — glossy violet with a halo, and everything else is secondary, so violet
 * means "the next click" wherever you are. Done keeps its green: it's the one
 * action that is also a status. `selected` is the on-state of any tab, nav
 * item or toggle.
 */
export const BUTTON = {
	primary:
		"bg-gradient-to-b from-primary-ink to-primary text-primary-foreground shadow-[0_2px_12px_-3px_color-mix(in_oklab,var(--primary)_70%,transparent)] hover:brightness-110",
	secondary:
		"bg-secondary text-soft-foreground ring-1 ring-inset ring-border shadow-[inset_0_1px_0_rgb(255_255_255/0.04)] hover:bg-accent hover:text-foreground",
	done: "bg-gradient-to-r from-success/25 to-success/10 text-success-ink ring-1 ring-inset ring-success/25 hover:from-success/35 hover:to-success/15",
	selected:
		"bg-gradient-to-r from-primary/20 to-primary/8 text-primary-ink ring-1 ring-inset ring-primary/30",
} as const;
