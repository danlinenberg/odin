import { pairingLink, startHostServer } from "main/lib/phone/host/server";

/**
 * The phone server on a remote host (main/lib/phone/host). Odin on the laptop
 * puts this file in the host user's ~/.odin/phone-host and runs it there:
 * `serve` keeps it answering phones; `link` prints the pairing link the laptop
 * shows as a QR code.
 */
const command = process.argv[2] ?? "serve";
if (command === "link") {
	process.stdout.write(`${pairingLink()}\n`);
} else if (command === "serve") {
	const server = startHostServer();
	if (!server) {
		console.log("[phone-host] already running");
		process.exit(0);
	}
	console.log("[phone-host] serving");
	for (const signal of ["SIGINT", "SIGTERM"] as const)
		process.on(signal, () => {
			server.stop();
			process.exit(0);
		});
} else {
	console.error(`Unknown command: ${command}`);
	process.exit(2);
}
