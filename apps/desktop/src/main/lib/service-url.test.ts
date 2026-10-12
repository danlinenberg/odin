import { expect, test } from "bun:test";
import { serviceUrl } from "./read-link";

test("a service path stays on its provider's host", () => {
	const base = "https://api.clickup.com/api/v2/";
	expect(serviceUrl(base, "/task/abc?x=1")?.href).toBe(
		"https://api.clickup.com/api/v2/task/abc?x=1",
	);
	expect(serviceUrl(base, "https://evil.example/steal")).toBeNull();
	expect(serviceUrl(base, "//evil.example/x")?.host).toBe("api.clickup.com");
});
