import { expect, test } from "bun:test";
import { hostByName } from "./host-by-name";

const prod = { name: "odin-prod", instanceId: "i-prod" };
const dev = { name: "odin-remote", instanceId: "i-dev" };

test("a session finds the host it started on after another is picked", () => {
	expect(hostByName(prod, [dev], "odin-remote")).toBe(dev);
	expect(hostByName(prod, [dev], "odin-prod")).toBe(prod);
	expect(hostByName(prod, [dev], undefined)).toBe(prod);
	expect(hostByName(prod, [dev], "gone")).toBe(prod);
});
