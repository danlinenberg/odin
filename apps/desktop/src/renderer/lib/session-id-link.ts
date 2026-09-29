import { TRPCClientError, type TRPCLink } from "@trpc/client";
import type { AnyRouter } from "@trpc/server";
import { observable } from "@trpc/server/observable";

/**
 * Global counter for unique operation IDs across all tRPC clients.
 * Starts from Date.now() to ensure uniqueness across page refreshes.
 */
let globalOperationId = Date.now();

/**
 * trpc-electron throws its own copy of TRPCClientError. @trpc/client v11 only
 * trusts `instanceof`, so it re-wraps that one and buries `data` (the tRPC
 * code — UNAUTHORIZED and friends) under `cause`, where nothing looks. Rebuilt
 * from the server's error shape here, `error.data.code` is there again.
 */
export function asClientError<E>(err: E): E {
	const shape = (err as { shape?: unknown }).shape;
	if (err instanceof TRPCClientError || !shape) return err;
	return TRPCClientError.from({ error: shape }) as E;
}

/**
 * Assigns globally unique operation IDs to prevent collisions between
 * the React client and proxy client (each creates separate IPCClients
 * that both receive all IPC responses and match by ID).
 */
export function sessionIdLink<TRouter extends AnyRouter>(): TRPCLink<TRouter> {
	return () => {
		return ({ op, next }) => {
			const uniqueId = ++globalOperationId;

			return observable((observer) => {
				return next({
					...op,
					id: uniqueId,
				}).subscribe({
					next: (result) => observer.next(result),
					error: (err) => observer.error(asClientError(err)),
					complete: () => observer.complete(),
				});
			});
		};
	};
}
