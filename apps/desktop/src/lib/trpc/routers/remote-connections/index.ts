import { remoteConnections } from "@odin/local-db";
import { TRPCError } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import { eq } from "drizzle-orm";
import { safeStorage } from "electron";
import { localDb } from "main/lib/local-db";
import {
	getRemoteConnectionManager,
	type RemoteConnectionStatusEvent,
} from "main/lib/remote-connection";
import {
	findClaude,
	listAwsProfiles,
	listInstances,
	listTagChoices,
	startInstance,
} from "main/lib/remote-connection/aws-instances";
import { toConfig } from "main/lib/remote-connection/config";
import { z } from "zod";
import { publicProcedure, router } from "../..";
import { readOdinConfig, updateOdinConfig } from "../odin-config";
import { execWithShellEnv } from "../workspaces/utils/shell-env";

const connectionInput = z.object({
	name: z.string().min(1),
	host: z.string().min(1),
	sshPort: z.number().int().positive().max(65_535).default(22),
	username: z.string().min(1),
	authMethod: z.enum(["key", "password"]).default("key"),
	sshKeyPath: z.string().nullable().default(null),
	// Plaintext here; encrypted with safeStorage before it touches the DB.
	password: z.string().nullable().default(null),
	odinFolder: z.string().min(1),
	remoteHostServicePort: z
		.number()
		.int()
		.positive()
		.max(65_535)
		.default(48_000),
});

const idInput = z.object({ id: z.string().min(1) });

const awsTarget = z.object({
	profile: z.string().optional(),
	region: z.string().optional(),
});
const tagPairs = z.array(z.object({ key: z.string(), value: z.string() }));

/**
 * Encrypt a password for storage. `undefined` means "leave unchanged" on an
 * update; `null`/empty clears it. Throws when the OS keychain is unavailable so
 * a password is never written in clear.
 */
function encryptPassword(
	plain: string | null | undefined,
): string | null | undefined {
	if (plain === undefined) return undefined;
	if (!plain) return null;
	if (!safeStorage.isEncryptionAvailable()) {
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message:
				"Secure storage is unavailable on this machine, so a password cannot be saved. Use an SSH key instead.",
		});
	}
	return safeStorage.encryptString(plain).toString("base64");
}

function requireRow(id: string): typeof remoteConnections.$inferSelect {
	const row = localDb
		.select()
		.from(remoteConnections)
		.where(eq(remoteConnections.id, id))
		.get();
	if (!row) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: `Remote connection ${id} not found`,
		});
	}
	return row;
}

export const createRemoteConnectionsRouter = () => {
	return router({
		list: publicProcedure.query(() => {
			return localDb.select().from(remoteConnections).all();
		}),

		get: publicProcedure.input(idInput).query(({ input }) => {
			return requireRow(input.id);
		}),

		getActive: publicProcedure.query(() => {
			return getRemoteConnectionManager().getActive();
		}),

		/**
		 * Whether sessions run on a server, including while it reconnects. The
		 * UI shows "Reconnecting" from this instead of falling back to local.
		 */
		isRemoteMode: publicProcedure.query(() => {
			return getRemoteConnectionManager().isRemoteMode();
		}),

		create: publicProcedure.input(connectionInput).mutation(({ input }) => {
			const { password, ...rest } = input;
			return localDb
				.insert(remoteConnections)
				.values({
					...rest,
					passwordEncrypted: encryptPassword(password) ?? null,
				})
				.returning()
				.get();
		}),

		update: publicProcedure
			.input(idInput.extend(connectionInput.partial().shape))
			.mutation(({ input }) => {
				const { id, password, ...patch } = input;
				requireRow(id);
				const encrypted = encryptPassword(password);
				return localDb
					.update(remoteConnections)
					.set({
						...patch,
						...(encrypted === undefined
							? {}
							: { passwordEncrypted: encrypted }),
						updatedAt: Date.now(),
					})
					.where(eq(remoteConnections.id, id))
					.returning()
					.get();
			}),

		delete: publicProcedure.input(idInput).mutation(({ input }) => {
			const row = requireRow(input.id);
			if (row.isActive) {
				getRemoteConnectionManager().disconnect();
			}
			localDb
				.delete(remoteConnections)
				.where(eq(remoteConnections.id, input.id))
				.run();
			return { success: true };
		}),

		testConnection: publicProcedure
			.input(idInput)
			.mutation(async ({ input }) => {
				const row = requireRow(input.id);
				return getRemoteConnectionManager().testConnection(toConfig(row));
			}),

		connect: publicProcedure.input(idInput).mutation(async ({ input }) => {
			const row = requireRow(input.id);
			const active = await getRemoteConnectionManager().connect(toConfig(row));
			// The active flag is what brings remote mode back on the next start.
			localDb
				.update(remoteConnections)
				.set({ isActive: false })
				.where(eq(remoteConnections.isActive, true))
				.run();
			localDb
				.update(remoteConnections)
				.set({ isActive: true })
				.where(eq(remoteConnections.id, input.id))
				.run();
			return active;
		}),

		disconnect: publicProcedure.mutation(() => {
			getRemoteConnectionManager().disconnect();
			localDb
				.update(remoteConnections)
				.set({ isActive: false })
				.where(eq(remoteConnections.isActive, true))
				.run();
			return { success: true };
		}),

		/** AWS instances: the profile, region and tags you picked, kept in odin.json. */
		awsSettings: publicProcedure.query(
			() => readOdinConfig().awsInstances ?? {},
		),
		setAwsSettings: publicProcedure
			.input(awsTarget.extend({ tags: tagPairs }))
			.mutation(({ input }) => {
				updateOdinConfig({ awsInstances: input });
			}),
		awsProfiles: publicProcedure.query(() =>
			listAwsProfiles().catch(() => [] as string[]),
		),
		awsTags: publicProcedure
			.input(awsTarget)
			.query(({ input }) => listTagChoices(input)),
		awsInstances: publicProcedure
			.input(awsTarget.extend({ tags: tagPairs }))
			.query(({ input }) => listInstances(input, input.tags)),
		awsStart: publicProcedure
			.input(awsTarget.extend({ id: z.string().min(1) }))
			.mutation(({ input }) => startInstance(input, input.id)),
		awsFindClaude: publicProcedure
			.input(
				awsTarget.extend({
					id: z.string().min(1),
					user: z.string().min(1),
					odinFolder: z.string().min(1),
				}),
			)
			.mutation(async ({ input }) => ({
				path: await findClaude(input, input.id, input.user, input.odinFolder),
			})),
		/** `aws sso login` for the picked profile; it opens the browser and waits for approval. */
		awsSignIn: publicProcedure.input(awsTarget).mutation(async ({ input }) => {
			await execWithShellEnv(
				"aws",
				[
					"sso",
					"login",
					...(input.profile ? ["--profile", input.profile] : []),
				],
				{ timeout: 5 * 60_000 },
			);
		}),

		onStatusChange: publicProcedure.subscription(() => {
			return observable<RemoteConnectionStatusEvent>((emit) => {
				return getRemoteConnectionManager().onStatusChange((event) =>
					emit.next(event),
				);
			});
		}),
	});
};
