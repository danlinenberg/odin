import type { ProjectSnapshotPayload } from "@odin/workspace-client";

/** A project row as served by the host (`project.list`). */
export interface HostProjectRow {
	id: string;
	name: string;
	repoPath: string;
	repoOwner: string | null;
	repoName: string | null;
	repoUrl: string | null;
	worktreeBaseDir: string | null;
	/** Custom icon data-URI, or null to fall back to the GitHub avatar. */
	icon: string | null;
	createdAt: number;
	updatedAt: number;
}

export const HOST_PROJECTS_QUERY_KEY = [
	"host-service",
	"projects",
	"list",
] as const;

/**
 * Normalize a project.list row. Hosts running pre-local-first builds don't
 * serve `name`/`createdAt`/`updatedAt` — fall back the same way the new host
 * does (folder basename; both path separators).
 */
export function normalizeHostProjectRow(
	row: Partial<HostProjectRow> & { id: string; repoPath: string },
): HostProjectRow {
	return {
		id: row.id,
		name: row.name || row.repoPath.split(/[\\/]/).pop() || row.id,
		repoPath: row.repoPath,
		repoOwner: row.repoOwner ?? null,
		repoName: row.repoName ?? null,
		repoUrl: row.repoUrl ?? null,
		worktreeBaseDir: row.worktreeBaseDir ?? null,
		icon: row.icon ?? null,
		createdAt: row.createdAt ?? 0,
		updatedAt: row.updatedAt ?? row.createdAt ?? 0,
	};
}

/**
 * Apply a project:changed event to the cached list. Created/updated upsert
 * from the event's snapshot payload; deleted removes the row.
 */
export function applyProjectChangedEvent(
	rows: HostProjectRow[] | undefined,
	event: {
		eventType: "created" | "updated" | "deleted";
		project: ProjectSnapshotPayload | null;
	},
	projectId: string,
): HostProjectRow[] | undefined {
	if (event.eventType === "deleted") {
		if (!rows) return rows;
		const next = rows.filter((row) => row.id !== projectId);
		return next.length === rows.length ? rows : next;
	}
	const snapshot = event.project;
	if (!snapshot) return rows;
	const existing = rows?.find((row) => row.id === snapshot.id);
	const nextRow: HostProjectRow = {
		id: snapshot.id,
		name: snapshot.name,
		repoPath: snapshot.repoPath,
		repoOwner: snapshot.repoOwner,
		repoName: snapshot.repoName,
		repoUrl: snapshot.repoUrl,
		worktreeBaseDir: snapshot.worktreeBaseDir,
		icon: snapshot.icon,
		createdAt: snapshot.createdAt,
		updatedAt: snapshot.updatedAt,
	};
	if (!rows) return [nextRow];
	return existing
		? rows.map((row) => (row.id === nextRow.id ? nextRow : row))
		: [...rows, nextRow];
}
