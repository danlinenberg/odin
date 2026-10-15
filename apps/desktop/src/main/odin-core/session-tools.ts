import http from "node:http";
import type { AddressInfo } from "node:net";
import type { AnyRouter } from "@trpc/server";
import {
	callProcedure,
	clip,
	listProcedures,
	setOdinApiRouter,
} from "main/lib/odin-api";
import { callService, fetchFile, readLink } from "main/lib/read-link";
import { patchPaneTags } from "./launcher";

/**
 * The tools a session calls on `http://127.0.0.1:$ODIN_PORT` - `/read`,
 * `/file`, `/odin` (api, call, service) - served on a remote server, where its
 * sessions run. Same protocol as the laptop's hook server
 * (main/lib/notifications/server.ts), backed by the connections running here,
 * so a session reads its Slack thread or Jira ticket with the laptop shut.
 *
 * Board actions (`/odin` tasks, start, sessions...) need the board's state;
 * until it lives on the server they answer that plainly.
 */

function send(
	res: http.ServerResponse,
	status: number,
	body: string | Buffer,
	type = "text/plain; charset=utf-8",
): void {
	res.writeHead(status, { "Content-Type": type });
	res.end(body);
}

async function readBody(req: http.IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}

async function handle(
	req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<void> {
	// Private threads and tickets: never to a page in a browser.
	if (req.headers.origin) return send(res, 403, "Not from a browser.\n");
	const url = new URL(req.url ?? "/", "http://127.0.0.1");

	if (req.method === "GET" && url.pathname === "/health") {
		return send(res, 200, '{"status":"ok"}', "application/json");
	}

	if (req.method === "GET" && url.pathname === "/read") {
		const link = url.searchParams.get("url");
		if (!link) return send(res, 400, "Need url.\n");
		try {
			return send(res, 200, `${await readLink(link)}\n`);
		} catch (error) {
			return send(
				res,
				502,
				`${error instanceof Error ? error.message : String(error)}\n`,
			);
		}
	}

	if (req.method === "GET" && url.pathname === "/file") {
		const link = url.searchParams.get("url");
		const file = link ? await fetchFile(link).catch(() => null) : null;
		if (!file) {
			return send(
				res,
				502,
				"Odin couldn't fetch that file. Reconnect that service in Odin's Settings > Connections to grant file access, then retry.\n",
			);
		}
		return send(
			res,
			200,
			Buffer.from(await file.arrayBuffer()),
			file.headers.get("content-type") ?? "application/octet-stream",
		);
	}

	// The laptop opens a Shell pane for this; a server has no window to.
	if (url.pathname === "/shell/run") {
		return send(
			res,
			503,
			"No Shell pane while Odin runs this session on a server - run it yourself with Bash (run_in_background for a long one).\n",
		);
	}

	if (req.method === "POST" && url.pathname === "/odin") {
		const form = new URLSearchParams(await readBody(req));
		const action = form.get("action");
		if (!action) {
			return send(res, 400, "Need action: api, call or service.\n");
		}
		if (action === "api") {
			return send(res, 200, `${listProcedures(form.get("q") ?? "")}\n`);
		}
		if (action === "call") {
			return send(
				res,
				200,
				`${await callProcedure(form.get("path") ?? "", form.get("input") ?? undefined)}\n`,
			);
		}
		if (action === "service") {
			const result = await callService(
				form.get("service") ?? "",
				form.get("path") ?? "",
				form.get("method") ?? undefined,
				form.get("body") ?? undefined,
			).catch(
				(error) =>
					`Failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			return send(res, 200, `${clip(result)}\n`);
		}
		// Card tags: what an automation drops once it's done with a session.
		if (action === "set" && form.get("store") === "sessions") {
			const result = patchPaneTags(form.get("patch") ?? "");
			return send(res, result.ok ? 200 : 400, `${result.message}\n`);
		}
		return send(
			res,
			503,
			`"${action}" changes Odin's board, which this server doesn't hold yet - Odin's window does.\n`,
		);
	}

	return send(res, 404, '{"error":"Not found"}', "application/json");
}

/**
 * Start the session tools on a free loopback port and publish it as
 * ODIN_SESSION_TOOLS_PORT, which host-service exports to every session's PTY
 * as ODIN_PORT.
 */
export async function startSessionTools(router: AnyRouter): Promise<number> {
	setOdinApiRouter(router);
	const server = http.createServer((req, res) => {
		handle(req, res).catch((error) => {
			if (!res.headersSent) {
				send(res, 500, `${error instanceof Error ? error.message : error}\n`);
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	process.env.ODIN_SESSION_TOOLS_PORT = String(port);
	console.log(`[odin-core] session tools on 127.0.0.1:${port}`);
	return port;
}
