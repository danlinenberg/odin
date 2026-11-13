import { describe, expect, test } from "bun:test";
import {
	isTransientApiError,
	TRANSIENT_RETRY,
	TRANSIENT_RETRY_MAX,
	transientRetryKey,
} from "./transient-retry";

const cloudflare = {
	role: "assistant",
	text: "Please run /login · API Error: 403 Attention Required! | Cloudflare",
};
const ask = { role: "user", text: "add a button" };
const retry = { role: "user", text: TRANSIENT_RETRY };

describe("isTransientApiError", () => {
	test("passing errors", () => {
		expect(isTransientApiError(cloudflare.text)).toBe(true);
		expect(isTransientApiError("API Error: 500 Internal server error")).toBe(
			true,
		);
		expect(isTransientApiError("API Error: 529 Overloaded")).toBe(true);
		expect(isTransientApiError("API Error: Connection error.")).toBe(true);
		expect(isTransientApiError("API Error: Request timed out.")).toBe(true);
	});
	test("real sign-in and other failures", () => {
		expect(isTransientApiError("Not logged in · Please run /login")).toBe(
			false,
		);
		expect(
			isTransientApiError(
				"Please run /login · API Error: 401 Invalid authentication credentials",
			),
		).toBe(false);
		expect(isTransientApiError("You've hit your weekly limit")).toBe(false);
	});
});

describe("transientRetryKey", () => {
	test("retries a passing error, one key per failed reply", () => {
		expect(transientRetryKey("p1", [ask, cloudflare])).toBe("p1:2");
		expect(transientRetryKey("p1", [ask, cloudflare, retry, cloudflare])).toBe(
			"p1:4",
		);
	});
	test("stops after the max retries in a row", () => {
		const msgs = [ask, cloudflare];
		for (let i = 0; i < TRANSIENT_RETRY_MAX; i++) msgs.push(retry, cloudflare);
		expect(transientRetryKey("p1", msgs)).toBeNull();
		expect(transientRetryKey("p1", [...msgs, ask, cloudflare])).not.toBeNull();
	});
	test("leaves other last replies alone", () => {
		expect(
			transientRetryKey("p1", [ask, { role: "assistant", text: "done" }]),
		).toBeNull();
		expect(transientRetryKey("p1", [])).toBeNull();
	});
});
