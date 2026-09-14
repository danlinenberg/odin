import { basename, resolve as resolvePath } from "node:path";
import { parseGitHubRemote } from "@odin/shared/github-remote";
import { BRANCH_PREFIX_MODES } from "@odin/shared/workspace-launch";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { projects, workspaces } from "../../../db/schema";
import {
	emitProjectChanged,
	toProjectSnapshot,
	updateLocalProject,
} from "../../../projects/local-project-store";
import { deleteLocalWorkspace } from "../../../workspaces/local-workspace-store";
import { protectedProcedure, router } from "../../index";
import { normalizeWorktreeBaseDir } from "../workspace-creation/shared/worktree-paths";
import {
	createFromClone,
	createFromEmpty,
	createFromImportLocal,
	createFromTemplate,
} from "./handlers";
import { ensureMainWorkspace } from "./utils/ensure-main-workspace";
import { persistLocalProject } from "./utils/persist-project";
import {
	cloneRepoInto,
	type ResolvedRepo,
	resolveLocalRepo,
	resolveMatchingSlug,
	tryRevParseGitRoot,
	validateDirectoryPath,
} from "./utils/resolve-repo";

// Icons are downscaled to a small square PNG data-URI client-side; this caps
// the stored/broadcast value (it rides in project.list and project:changed).
const MAX_PROJECT_ICON_LENGTH = 256 * 1024;

export const projectRouter = router({
	list: protectedProcedure.query(({ ctx }) => {
		return ctx.db
			.select()
			.from(projects)
			.all()
			.map((row) => ({
				id: row.id,
				// Empty until the backfill sweep fills it; folder name is the
				// honest fallback (same rule as toProjectSnapshot).
				name: row.name || basename(row.repoPath),
				repoPath: row.repoPath,
				repoOwner: row.repoOwner,
				repoName: row.repoName,
				repoUrl: row.repoUrl,
				worktreeBaseDir: row.worktreeBaseDir,
				icon: row.icon,
				createdAt: row.createdAt,
				updatedAt: row.updatedAt || row.createdAt,
			}));
	}),

	/** Rename. Commits locally — projects have no cloud dependency. */
	update: protectedProcedure
		.input(
			z.object({
				projectId: z.string().uuid(),
				name: z.string().min(1),
			}),
		)
		.mutation(({ ctx, input }) => {
			const row = updateLocalProject(
				{ db: ctx.db, eventBus: ctx.eventBus },
				input.projectId,
				{ name: input.name },
			);
			if (!row) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Project is not set up on this host",
				});
			}
			return toProjectSnapshot(row);
		}),

	get: protectedProcedure
		.input(z.object({ projectId: z.string().uuid() }))
		.query(({ ctx, input }) => {
			const row = ctx.db
				.select()
				.from(projects)
				.where(eq(projects.id, input.projectId))
				.get();
			if (!row) return null;
			return {
				id: row.id,
				// Same fallback rule as project.list / toProjectSnapshot.
				name: row.name || basename(row.repoPath),
				repoPath: row.repoPath,
				repoOwner: row.repoOwner,
				repoName: row.repoName,
				repoUrl: row.repoUrl,
				worktreeBaseDir: row.worktreeBaseDir,
				branchPrefixMode: row.branchPrefixMode,
				branchPrefixCustom: row.branchPrefixCustom,
				icon: row.icon,
			};
		}),

	/**
	 * Set (or clear) this project's custom icon. Local-first: the icon is a
	 * small downscaled data-URI stored on the host row. A null clears it so the
	 * project falls back to the GitHub owner avatar / placeholder.
	 */
	setIcon: protectedProcedure
		.input(
			z.object({
				projectId: z.string().uuid(),
				icon: z
					.string()
					.max(MAX_PROJECT_ICON_LENGTH, "Icon image is too large")
					.regex(/^data:image\//, "Icon must be an image data URI")
					.nullable(),
			}),
		)
		.mutation(({ ctx, input }) => {
			const row = updateLocalProject(
				{ db: ctx.db, eventBus: ctx.eventBus },
				input.projectId,
				{ icon: input.icon },
			);
			if (!row) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Project is not set up on this host",
				});
			}
			return toProjectSnapshot(row);
		}),

	setWorktreeBaseDir: protectedProcedure
		.input(
			z.object({
				projectId: z.string().uuid(),
				path: z.string().nullable(),
			}),
		)
		.mutation(({ ctx, input }) => {
			const worktreeBaseDir = normalizeWorktreeBaseDir(input.path);
			ctx.db
				.update(projects)
				.set({ worktreeBaseDir })
				.where(eq(projects.id, input.projectId))
				.run();

			const project = ctx.db.query.projects
				.findFirst({ where: eq(projects.id, input.projectId) })
				.sync();
			if (!project) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Project is not set up on this host",
				});
			}

			return {
				id: project.id,
				worktreeBaseDir: project.worktreeBaseDir ?? null,
			};
		}),

	/**
	 * Set this project's branch-prefix override. A `null` mode clears the
	 * override so the project falls back to the host-wide default.
	 */
	setBranchPrefix: protectedProcedure
		.input(
			z.object({
				projectId: z.string().uuid(),
				mode: z.enum(BRANCH_PREFIX_MODES).nullable(),
				customPrefix: z.string().nullable().optional(),
			}),
		)
		.mutation(({ ctx, input }) => {
			const updated = ctx.db
				.update(projects)
				.set({
					branchPrefixMode: input.mode,
					branchPrefixCustom: input.customPrefix ?? null,
				})
				.where(eq(projects.id, input.projectId))
				.returning({ id: projects.id })
				.get();
			if (!updated) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: `Project not set up locally: ${input.projectId}`,
				});
			}
			return { success: true as const };
		}),

	findBackfillConflict: protectedProcedure
		.input(
			z.object({
				projectId: z.string().uuid(),
				repoPath: z.string().min(1),
			}),
		)
		.query(() => {
			// Multiple v2 projects may point at the same GitHub URL, so a matching
			// repo URL is no longer a conflict. Kept for backwards-compatible
			// clients while older settings screens still call the endpoint.
			return { conflict: null };
		}),

	findByPath: protectedProcedure
		.input(
			z.object({
				repoPath: z.string().min(1),
				/**
				 * Opt-in to the v1→v2 importer's discovery semantics: match
				 * the local-DB row against `expectedRemoteUrl`. Default
				 * `false` preserves the long-standing folder-first import
				 * behavior.
				 */
				walkAllRemotes: z.boolean().optional(),
				/**
				 * Hint about the remote URL the caller *thinks* this project
				 * tracks (e.g. v1's recorded githubOwner). Only consulted
				 * when `walkAllRemotes` is true.
				 */
				expectedRemoteUrl: z.string().optional(),
			}),
		)
		.query(async ({ ctx, input }) => {
			// Detect "folder isn't a git repo yet" without throwing, so the import
			// UI can offer to `git init` it (create importLocal + initIfNeeded)
			// instead of dead-ending on a BAD_REQUEST. Additive optional field —
			// repo paths never carry needsGitInit, so existing callers are
			// unaffected.
			const root = await tryRevParseGitRoot(input.repoPath);
			if (root === null) {
				validateDirectoryPath(input.repoPath, "Path"); // 400 on missing / not-a-dir
				return {
					candidates: [],
					needsGitInit: true as const,
				};
			}

			const resolved = await resolveLocalRepo(root);
			const gitRoot = resolved.repoPath;

			const expectedParsed =
				input.walkAllRemotes && input.expectedRemoteUrl
					? parseGitHubRemote(input.expectedRemoteUrl)
					: null;
			const expectedUrlLower = expectedParsed?.url.toLowerCase();
			const matches = (cloneUrl: string | null) =>
				!!expectedUrlLower &&
				!!cloneUrl &&
				cloneUrl.toLowerCase() === expectedUrlLower;

			interface Candidate {
				id: string;
				name: string;
				repoCloneUrl: string | null;
				source: "local-path";
				matchesExpected: boolean;
			}

			const localProject = ctx.db.query.projects
				.findFirst({ where: eq(projects.repoPath, gitRoot) })
				.sync();

			// Default behavior (folder-first import): a local-DB hit is the
			// only candidate source — no hit means the caller creates a fresh
			// local project.
			if (!input.walkAllRemotes) {
				if (localProject) {
					return {
						candidates: [
							{
								id: localProject.id,
								name:
									localProject.name ||
									localProject.repoName ||
									basename(gitRoot),
								repoCloneUrl: localProject.repoUrl ?? null,
								source: "local-path" as const,
								matchesExpected: false,
							},
						],
					};
				}
				return { candidates: [] };
			}

			// walkAllRemotes branch — v1→v2 importer.
			const candidates: Candidate[] = localProject
				? [
						{
							id: localProject.id,
							name: localProject.repoName ?? basename(gitRoot),
							repoCloneUrl: localProject.repoUrl ?? null,
							source: "local-path",
							matchesExpected: matches(localProject.repoUrl ?? null),
						},
					]
				: [];

			return { candidates };
		}),

	create: protectedProcedure
		.input(
			z.object({
				name: z.string().min(1),
				mode: z.discriminatedUnion("kind", [
					z.object({
						kind: z.literal("empty"),
						parentDir: z.string().min(1),
					}),
					z.object({
						kind: z.literal("clone"),
						parentDir: z.string().min(1),
						url: z.string().min(1),
					}),
					z.object({
						kind: z.literal("importLocal"),
						repoPath: z.string().min(1),
						// When set, `git init` a non-git folder in place before
						// importing. The UI sets this only after confirming intent
						// with the user (see findByPath's needsGitInit).
						initIfNeeded: z.boolean().optional().default(false),
					}),
					z.object({
						kind: z.literal("template"),
						parentDir: z.string().min(1),
						url: z
							.string()
							.min(1)
							.refine((value) => /^https?:\/\//i.test(value), {
								message: "Template URL must be http(s)",
							}),
					}),
				]),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			switch (input.mode.kind) {
				case "empty":
					return createFromEmpty(ctx, {
						name: input.name,
						parentDir: input.mode.parentDir,
					});
				case "template":
					return createFromTemplate(ctx, {
						name: input.name,
						parentDir: input.mode.parentDir,
						url: input.mode.url,
					});
				case "clone":
					return createFromClone(ctx, {
						name: input.name,
						parentDir: input.mode.parentDir,
						url: input.mode.url,
					});
				case "importLocal":
					return createFromImportLocal(ctx, {
						name: input.name,
						repoPath: input.mode.repoPath,
						initIfNeeded: input.mode.initIfNeeded,
					});
			}
		}),

	setup: protectedProcedure
		.input(
			z.object({
				projectId: z.string().uuid(),
				/**
				 * Repo coordinates supplied by the caller (from the host
				 * fan-out) so a project created on ANOTHER host can be set up
				 * on this device.
				 */
				origin: z
					.object({
						repoCloneUrl: z.string().nullish(),
						name: z.string().min(1).optional(),
					})
					.optional(),
				mode: z.discriminatedUnion("kind", [
					z.object({
						kind: z.literal("clone"),
						parentDir: z.string().min(1),
					}),
					z.object({
						kind: z.literal("import"),
						repoPath: z.string().min(1),
						allowRelocate: z.boolean().default(false),
					}),
				]),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const existing = ctx.db
				.select({ id: projects.id, repoPath: projects.repoPath })
				.from(projects)
				.where(eq(projects.id, input.projectId))
				.get();

			const origin = {
				repoCloneUrl: input.origin?.repoCloneUrl ?? null,
				name: input.origin?.name,
			};

			const allowRelocate =
				input.mode.kind === "import" && input.mode.allowRelocate;

			const rejectIfRepoint = (targetPath: string) => {
				if (!existing) return;
				if (existing.repoPath === targetPath) return;
				if (allowRelocate) return;
				throw new TRPCError({
					code: "CONFLICT",
					message: `Project is already set up on this device at ${existing.repoPath}. Remove it first to re-import at a different location.`,
				});
			};

			switch (input.mode.kind) {
				case "clone": {
					if (existing) {
						// Already on this device — same folder name predicted from
						// the local row; a different parentDir means a repoint.
						rejectIfRepoint(
							resolvePath(input.mode.parentDir, basename(existing.repoPath)),
						);
						const mainWorkspace = await ensureMainWorkspace(
							ctx,
							input.projectId,
							existing.repoPath,
						);
						return {
							repoPath: existing.repoPath,
							mainWorkspaceId: mainWorkspace?.id ?? null,
						};
					}
					if (!origin.repoCloneUrl) {
						throw new TRPCError({
							code: "BAD_REQUEST",
							message:
								"Project has no linked GitHub repository — cannot clone. Import an existing local folder instead.",
						});
					}
					const expectedParsed = parseGitHubRemote(origin.repoCloneUrl);
					if (!expectedParsed) {
						throw new TRPCError({
							code: "BAD_REQUEST",
							message: `Could not parse GitHub remote from ${origin.repoCloneUrl}`,
						});
					}
					const resolved = await cloneRepoInto(
						origin.repoCloneUrl,
						input.mode.parentDir,
						ctx.credentials,
					);
					persistLocalProject(ctx, input.projectId, resolved, {
						name: origin.name,
					});
					const mainWorkspace = await ensureMainWorkspace(
						ctx,
						input.projectId,
						resolved.repoPath,
					);
					return {
						repoPath: resolved.repoPath,
						mainWorkspaceId: mainWorkspace?.id ?? null,
					};
				}
				case "import": {
					let resolved: ResolvedRepo;
					if (origin.repoCloneUrl) {
						const parsed = parseGitHubRemote(origin.repoCloneUrl);
						if (!parsed) {
							throw new TRPCError({
								code: "BAD_REQUEST",
								message: `Could not parse GitHub remote from ${origin.repoCloneUrl}`,
							});
						}
						resolved = await resolveMatchingSlug(
							input.mode.repoPath,
							`${parsed.owner}/${parsed.name}`,
						);
					} else {
						resolved = await resolveLocalRepo(input.mode.repoPath);
					}

					// Each on-disk repo path maps to at most one project in the
					// local DB; importing the same folder under a second project
					// would clobber the first. GitHub URL collisions are allowed
					// (see findBackfillConflict), but local-path collisions are
					// not.
					const localOwner = ctx.db
						.select({ id: projects.id })
						.from(projects)
						.where(eq(projects.repoPath, resolved.repoPath))
						.get();
					if (localOwner && localOwner.id !== input.projectId) {
						throw new TRPCError({
							code: "CONFLICT",
							message:
								"Repository is already set up as another project on this device.",
						});
					}

					rejectIfRepoint(resolved.repoPath);
					if (existing && existing.repoPath === resolved.repoPath) {
						const mainWorkspace = await ensureMainWorkspace(
							ctx,
							input.projectId,
							existing.repoPath,
						);
						return {
							repoPath: existing.repoPath,
							mainWorkspaceId: mainWorkspace?.id ?? null,
						};
					}

					persistLocalProject(ctx, input.projectId, resolved, {
						name: origin.name,
					});
					const mainWorkspace = await ensureMainWorkspace(
						ctx,
						input.projectId,
						resolved.repoPath,
					);
					return {
						repoPath: resolved.repoPath,
						mainWorkspaceId: mainWorkspace?.id ?? null,
					};
				}
			}
		}),

	/**
	 * Project-delete saga:
	 *
	 *   1. Ownership check: an id this host doesn't serve is a no-op.
	 *
	 *   2. Best-effort `git worktree remove` for each non-main local
	 *      workspace so subsequent worktree commands aren't confused.
	 *
	 *   3. Local DB rows (workspaces + project). A failure here surfaces as
	 *      an error — the local table is what the UI lists from, so a
	 *      swallowed failure would toast "Deleted" over a surviving row.
	 *
	 * The on-disk repo directory is NEVER auto-removed. The user's code is
	 * their code; deletion of the working tree must be an explicit action,
	 * not a side-effect of project removal. Returns repoPath so a future
	 * UI can offer an explicit "delete files too" follow-up.
	 */
	remove: protectedProcedure
		.input(z.object({ projectId: z.string().uuid() }))
		.mutation(async ({ ctx, input }) => {
			const localProject = ctx.db.query.projects
				.findFirst({ where: eq(projects.id, input.projectId) })
				.sync();
			if (!localProject) return { success: true, repoPath: null };

			const localWorkspaces = ctx.db
				.select()
				.from(workspaces)
				.where(eq(workspaces.projectId, input.projectId))
				.all();

			for (const ws of localWorkspaces) {
				if (ws.worktreePath === localProject.repoPath) continue;
				try {
					const git = await ctx.git(localProject.repoPath);
					await git.raw(["worktree", "remove", ws.worktreePath]);
				} catch (err) {
					console.warn("[project.remove] failed to remove worktree", {
						projectId: input.projectId,
						worktreePath: ws.worktreePath,
						err,
					});
				}
			}

			try {
				// Per-row so each deletion broadcasts.
				for (const ws of localWorkspaces) {
					deleteLocalWorkspace(ctx, ws.id);
				}
				ctx.db.delete(projects).where(eq(projects.id, input.projectId)).run();
				emitProjectChanged(ctx.eventBus, "deleted", input.projectId);
			} catch (err) {
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message: `Failed to delete project locally: ${err instanceof Error ? err.message : String(err)}`,
				});
			}

			return { success: true, repoPath: localProject.repoPath };
		}),
});
