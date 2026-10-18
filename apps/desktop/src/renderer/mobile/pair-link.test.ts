import { expect, test } from "bun:test";
import { parsePairLink } from "./pair-link";

const k = "A".repeat(43);
const link = `odin://pair?k=${k}&c=code123&l=${encodeURIComponent("ws://dans-mac.local:4747/channel")}&r=${encodeURIComponent("wss://relay.example.com")}`;

test("Odin's QR link gives the key, the code and both addresses", () => {
	expect(parsePairLink(`  ${link}\n`)).toEqual({
		link,
		host: k,
		code: "code123",
		lan: "ws://dans-mac.local:4747/channel",
		relay: "wss://relay.example.com",
	});
});

test("a relay must be wss://; plain ws:// is for the Wi-Fi only", () => {
	const plainRelay = `odin://pair?k=${k}&r=${encodeURIComponent("ws://relay.example.com")}`;
	expect(parsePairLink(plainRelay)).toBeNull();
});

test("anything else is not a pairing link", () => {
	for (const bad of [
		"",
		"hello",
		"http://dans-mac.local:4747/?t=abc",
		"odin://pair",
		`odin://pair?k=short&l=${encodeURIComponent("ws://mac.local/channel")}`,
		`odin://pair?k=${k}`,
	])
		expect(parsePairLink(bad)).toBeNull();
});
