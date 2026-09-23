import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { collectResourceMetrics } from "main/lib/resource-metrics";
import { z } from "zod";
import { publicProcedure, router } from "..";
import {
	resourceMetricsSnapshotSchema,
	validateResourceMetricsSnapshot,
} from "./resource-metrics.schema";

const getSnapshotInputSchema = z
	.object({
		mode: z.enum(["interactive", "idle"]).optional(),
		force: z.boolean().optional(),
		surface: z.enum(["v1", "v2"]).optional(),
		organizationId: z.string().optional(),
	})
	.optional();

const run = promisify(execFile);

export interface ClaudeUsageWindow {
	percent: number;
	resetsAt: string | null;
}

/**
 * The same numbers Claude Code's /usage shows: the rolling 5-hour window and
 * the week. Read with the Claude Code login from the macOS keychain; null when
 * there is no login or the endpoint is down — the pill just isn't drawn.
 */
async function claudeUsage(): Promise<{
	fiveHour: ClaudeUsageWindow | null;
	week: ClaudeUsageWindow | null;
} | null> {
	try {
		const { stdout } = await run("security", [
			"find-generic-password",
			"-s",
			"Claude Code-credentials",
			"-w",
		]);
		const token = JSON.parse(stdout).claudeAiOauth?.accessToken;
		if (!token) return null;
		const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
			headers: {
				Authorization: `Bearer ${token}`,
				"anthropic-beta": "oauth-2025-04-20",
			},
			signal: AbortSignal.timeout(10_000),
		});
		if (!res.ok) return null;
		const body = await res.json();
		const window = (w: unknown): ClaudeUsageWindow | null => {
			const v = w as { utilization?: number; resets_at?: string | null } | null;
			return typeof v?.utilization === "number"
				? { percent: Math.round(v.utilization), resetsAt: v.resets_at ?? null }
				: null;
		};
		return { fiveHour: window(body.five_hour), week: window(body.seven_day) };
	} catch {
		return null;
	}
}

export const createResourceMetricsRouter = () => {
	return router({
		getSnapshot: publicProcedure
			.input(getSnapshotInputSchema)
			.output(resourceMetricsSnapshotSchema)
			.query(async ({ input }) => {
				const snapshot = await collectResourceMetrics({
					mode: input?.mode,
					force: input?.force,
					surface: input?.surface,
					organizationId: input?.organizationId,
				});
				const validation = validateResourceMetricsSnapshot(snapshot);
				if (!validation.isValid) {
					console.warn(
						"[resource-metrics] Invalid snapshot payload; returning fallback snapshot",
						validation.issues,
					);
				}
				return validation.snapshot;
			}),
		getClaudeUsage: publicProcedure.query(() => claudeUsage()),
	});
};
