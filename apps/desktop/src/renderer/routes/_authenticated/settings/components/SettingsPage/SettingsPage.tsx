import { Input } from "@odin/ui/input";
import { Label } from "@odin/ui/label";
import { cn } from "@odin/ui/utils";
import type { ReactNode } from "react";

/**
 * The one shape every Odin settings screen takes: a title, a line saying
 * what's on it, then titled cards of rows. Same shape everywhere so a setting
 * is found by reading headings, not by remembering which screen styled what.
 */
export function SettingsPage({
	title,
	description,
	action,
	children,
}: {
	title: string;
	description: ReactNode;
	action?: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="w-full max-w-3xl px-8 py-8">
			<header className="mb-8 flex items-start justify-between gap-4">
				<div>
					<h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
					<p className="mt-1.5 text-sm text-muted-foreground">{description}</p>
				</div>
				{action}
			</header>
			<div className="space-y-10">{children}</div>
		</div>
	);
}

/** A titled card of rows - one topic, e.g. "When sessions start". */
export function SettingsSection({
	title,
	description,
	children,
}: {
	title: string;
	description?: ReactNode;
	children: ReactNode;
}) {
	return (
		<section data-setting={title}>
			<div className="mb-3 px-1">
				<h3 className="text-[13px] font-semibold uppercase tracking-[.06em] text-soft-foreground">
					{title}
				</h3>
				{description && (
					<p className="mt-1 text-[13px] text-muted-foreground">
						{description}
					</p>
				)}
			</div>
			<div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card/60">
				{children}
			</div>
		</section>
	);
}

/**
 * Label and explanation on the left, the control on the right. `stacked` puts
 * the control underneath instead, for text areas and lists.
 */
export function SettingRow({
	label,
	htmlFor,
	description,
	stacked,
	children,
}: {
	label: ReactNode;
	htmlFor?: string;
	description?: ReactNode;
	stacked?: boolean;
	children?: ReactNode;
}) {
	return (
		<div
			// What Settings search scrolls to (settings-index.ts).
			data-setting={typeof label === "string" ? label : undefined}
			className={cn(
				"flex gap-6 px-4 py-3.5",
				stacked ? "flex-col gap-3" : "items-center justify-between",
			)}
		>
			<div className="min-w-0 space-y-0.5">
				<Label htmlFor={htmlFor} className="text-sm font-medium">
					{label}
				</Label>
				{description && (
					<p className="max-w-xl text-[13px] leading-relaxed text-muted-foreground">
						{description}
					</p>
				)}
			</div>
			{children && (
				<div className={cn(!stacked && "flex shrink-0 items-center gap-1.5")}>
					{children}
				</div>
			)}
		</div>
	);
}

/**
 * A number box that only saves values inside its range.
 * ponytail: an empty or out-of-range box keeps the last good value rather than
 * arguing - the field is the only place to fix it.
 */
export function NumberSetting({
	id,
	value,
	min,
	max,
	step,
	unit,
	onChange,
}: {
	id: string;
	value: number;
	min: number;
	max: number;
	step: number;
	unit: string;
	onChange: (next: number) => void;
}) {
	return (
		<>
			<Input
				id={id}
				type="number"
				min={min}
				max={max}
				step={step}
				defaultValue={value}
				className="w-20 tabular-nums"
				onChange={(event) => {
					const next = event.target.valueAsNumber;
					if (Number.isFinite(next) && next >= min && next <= max)
						onChange(next);
				}}
			/>
			<span className="w-16 text-sm text-muted-foreground">{unit}</span>
		</>
	);
}

/** Connected-as line with a green / grey / red dot. */
export function StatusDot({
	loading,
	configured,
	identity,
	error,
}: {
	loading: boolean;
	configured: boolean;
	identity: string | null;
	error: string | null;
}) {
	if (loading)
		return <span className="text-xs text-muted-foreground">checking…</span>;
	const color = !configured
		? "bg-muted-foreground/30"
		: error
			? "bg-danger"
			: "bg-success";
	const label = !configured
		? "Not connected"
		: error
			? `Failed: ${error}`
			: (identity ?? "Connected");
	return (
		<div className="flex items-center gap-1.5">
			<span className={cn("size-2 rounded-full", color)} />
			<span
				className={cn(
					"select-text cursor-text text-xs",
					error ? "text-danger" : "text-muted-foreground",
				)}
			>
				{label}
			</span>
		</div>
	);
}
