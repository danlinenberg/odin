import { describe, expect, it } from "bun:test";
import {
	type ClickupCall,
	closeClickupTask,
	closingStatus,
} from "./clickup-close";

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status });

/** A fake ClickUp: answers each path from `routes`, and records every call. */
function fakeClickup(routes: Record<string, () => Response>) {
	const calls: { path: string; method: string; body?: string }[] = [];
	const call: ClickupCall = async (path, _token, init) => {
		const method = init?.method ?? "GET";
		calls.push({ path, method, body: init?.body });
		const route = routes[`${method} ${path}`];
		return route ? route() : json({ err: "not found" }, 404);
	};
	return { call, calls };
}

const LIST = {
	statuses: [
		{ status: "to do", type: "open" },
		{ status: "in review", type: "custom" },
		{ status: "shipped", type: "done" },
		{ status: "archived", type: "closed" },
	],
};

describe("closingStatus", () => {
	it("takes the closed status, else the done one, by type not name", () => {
		expect(closingStatus(LIST.statuses)).toBe("archived");
		expect(
			closingStatus(LIST.statuses.filter((s) => s.type !== "closed")),
		).toBe("shipped");
		expect(closingStatus([{ status: "Complete", type: "Closed" }])).toBe(
			"Complete",
		);
		expect(closingStatus([{ status: "done", type: "custom" }])).toBeNull();
	});
});

describe("closeClickupTask", () => {
	it("looks up the list's statuses and sets the task to the closed one", async () => {
		const { call, calls } = fakeClickup({
			"GET task/abc": () =>
				json({ status: { status: "in review" }, list: { id: "L1" } }),
			"GET list/L1": () => json(LIST),
			"PUT task/abc": () => json({}),
		});
		expect(await closeClickupTask("abc", "tok", call)).toEqual({
			status: "archived",
		});
		expect(calls.at(-1)).toEqual({
			path: "task/abc",
			method: "PUT",
			body: JSON.stringify({ status: "archived" }),
		});
	});

	it("leaves a task that is already closed alone", async () => {
		const { call, calls } = fakeClickup({
			"GET task/abc": () =>
				json({ status: { status: "Archived" }, list: { id: "L1" } }),
			"GET list/L1": () => json(LIST),
		});
		await closeClickupTask("abc", "tok", call);
		expect(calls.some((c) => c.method === "PUT")).toBe(false);
	});

	it("throws when the list has no closed or done status", async () => {
		const { call } = fakeClickup({
			"GET task/abc": () => json({ list: { id: "L1" } }),
			"GET list/L1": () =>
				json({ statuses: [{ status: "to do", type: "open" }] }),
		});
		await expect(closeClickupTask("abc", "tok", call)).rejects.toThrow(
			"no closed or done status",
		);
	});

	it("throws with what ClickUp said when the update is refused", async () => {
		const { call } = fakeClickup({
			"GET task/abc": () => json({ list: { id: "L1" } }),
			"GET list/L1": () => json(LIST),
			"PUT task/abc": () => json({ err: "no access" }, 403),
		});
		await expect(closeClickupTask("abc", "tok", call)).rejects.toThrow(
			"can't edit this task",
		);
	});

	it("throws when the task can't be read", async () => {
		const { call } = fakeClickup({});
		await expect(closeClickupTask("abc", "tok", call)).rejects.toThrow(
			"HTTP 404",
		);
	});
});
