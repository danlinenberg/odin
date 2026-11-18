/**
 * Reports every animation frame the window held for a second or more, with
 * the scripts that ran in it, as a `[freeze]` console line that main writes
 * to ~/.odin/freeze.log (main/lib/freeze-log.ts).
 */
const FREEZE_MS = 1_000;

interface ScriptTiming {
	duration: number;
	invoker?: string;
	sourceURL?: string;
	sourceFunctionName?: string;
	sourceCharPosition?: number;
}

export function describeFrame(
	duration: number,
	scripts: ScriptTiming[],
	path: string,
): string {
	const top = [...scripts]
		.sort((a, b) => b.duration - a.duration)
		.slice(0, 3)
		.map((script) => {
			const file = script.sourceURL?.split("/").pop() || "?";
			const fn = script.sourceFunctionName || "anonymous";
			return `${Math.round(script.duration)}ms ${script.invoker ?? "?"} ${fn} ${file}:${script.sourceCharPosition ?? 0}`;
		});
	return `[freeze] frame ${Math.round(duration)}ms on ${path}${top.length ? ` | ${top.join(" | ")}` : ""}`;
}

export function startFreezeReporter(): void {
	if (
		!PerformanceObserver.supportedEntryTypes?.includes("long-animation-frame")
	)
		return;
	new PerformanceObserver((list) => {
		for (const entry of list.getEntries()) {
			if (entry.duration < FREEZE_MS) continue;
			const scripts = (entry as PerformanceEntry & { scripts?: ScriptTiming[] })
				.scripts;
			console.warn(
				describeFrame(entry.duration, scripts ?? [], location.hash || "/"),
			);
		}
	}).observe({ type: "long-animation-frame", buffered: true });
}
