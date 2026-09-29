import { expect, test } from "bun:test";
import { TRPCClientError } from "@trpc/client";
import { asClientError } from "./session-id-link";

test("a foreign TRPCClientError keeps its tRPC code", () => {
	// What trpc-electron throws: its own class, the server's error on `shape`.
	const foreign = Object.assign(new Error("Gmail rejected (401)"), {
		name: "TRPCClientError",
		shape: {
			message: "Gmail rejected (401)",
			code: -32001,
			data: { code: "UNAUTHORIZED", httpStatus: 401 },
		},
	});
	const fixed = asClientError(foreign) as unknown as {
		message: string;
		data?: { code?: string };
	};
	expect(fixed).toBeInstanceOf(TRPCClientError);
	expect(fixed.message).toBe("Gmail rejected (401)");
	expect(fixed.data?.code).toBe("UNAUTHORIZED");
});

test("anything else passes through untouched", () => {
	const plain = new Error("boom");
	expect(asClientError(plain)).toBe(plain);
});
