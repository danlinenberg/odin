import { afterAll, expect, test } from "bun:test";
import { connect, createServer, type Socket } from "node:net";
import { connectSocket } from "@odin/channel";
import { startRelay } from "@odin/relay";
import { dialRelay } from "./channel-host";

const relay = startRelay({ port: 0, hostname: "127.0.0.1" });

// The network between this computer and the relay. `sleep` is a laptop lid
// closing: the relay's end of each connection goes, and this end hears
// nothing about it - no close, no error.
const upstreams: Socket[] = [];
const network = createServer((client) => {
	const upstream = connect(relay.port as number, "127.0.0.1");
	upstreams.push(upstream);
	client.pipe(upstream);
	upstream.on("data", (data) => client.write(data));
	client.on("error", () => {});
	upstream.on("error", () => {});
}).listen(0, "127.0.0.1");
const sleep = () => {
	for (const upstream of upstreams.splice(0)) upstream.destroy();
};

afterAll(() => {
	network.close();
	void relay.stop(true);
});

const ID = "abcdefghijklmnopqrstuv";

test("a relay that lost this computer during sleep gets it back, with no close to tell it", async () => {
	const { port } = network.address() as { port: number };
	let phones = 0;
	const states: string[] = [];
	const stop = dialRelay(
		`ws://127.0.0.1:${port}`,
		ID,
		() => phones++,
		(state) => states.push(state),
		100,
	);
	try {
		await Bun.sleep(50);
		sleep();
		await Bun.sleep(300);
		// A phone asks the relay for this computer: it is there again.
		const phone = await connectSocket(
			`ws://127.0.0.1:${relay.port}/connect/${ID}`,
		);
		await Bun.sleep(100);
		expect(phone.readyState).toBe(WebSocket.OPEN);
		expect(phones).toBe(1);
		// Settings never saw it drop: the old connection stayed until the new one was up.
		expect(states).toEqual(["connecting", "connected"]);
		phone.close();
	} finally {
		stop();
	}
});
