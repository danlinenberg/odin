import { expect, test } from "bun:test";
import { utils } from "ssh2";
import { loginKeyPair } from "./ssh";

test("a login key is one ssh2 can parse, every time", () => {
	for (let i = 0; i < 50; i++) {
		const key = loginKeyPair();
		expect(utils.parseKey(key.private)).not.toBeInstanceOf(Error);
		expect(key.public).toStartWith("ssh-ed25519 ");
	}
	expect(loginKeyPair({ comment: "odin-test" }).public).toContain("odin-test");
});
