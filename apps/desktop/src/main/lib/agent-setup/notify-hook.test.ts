import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NOTIFY_SCRIPT_MARKER } from "./notify-hook";

const notifyHookTemplatePath = path.join(
	import.meta.dir,
	"templates",
	"notify-hook.template.sh",
);

function readNotifyHookTemplate(): string {
	return readFileSync(notifyHookTemplatePath, "utf-8");
}

/**
 * Async on purpose: the port-routing tests answer the hook from an in-process
 * `Bun.serve`, and `spawnSync` would block the loop that has to serve it.
 */
async function runNotifyHook(
	input: Record<string, unknown>,
	options: { defaultPort?: number; env?: Record<string, string> } = {},
) {
	const script = readNotifyHookTemplate()
		.replaceAll("{{MARKER}}", NOTIFY_SCRIPT_MARKER)
		.replaceAll("{{DEFAULT_PORT}}", String(options.defaultPort ?? 48763));
	const child = Bun.spawn({
		cmd: ["bash", "-c", script],
		env: {
			...process.env,
			ODIN_AGENT_ID: "grok",
			ODIN_DEBUG_HOOKS: "1",
			...options.env,
		},
		stdin: Buffer.from(JSON.stringify(input)),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { exitCode: await child.exited, stdout, stderr };
}

describe("getNotifyScriptContent", () => {
	it("bumps the notify hook marker when hook semantics change", () => {
		expect(NOTIFY_SCRIPT_MARKER).toBe("# Odin agent notification hook v5");
	});

	it("emits the v2 host-service payload with full agent identity", () => {
		const script = readNotifyHookTemplate();

		expect(script).toContain('HOOK_SESSION_ID=$(echo "$INPUT"');
		expect(script).toContain(
			'PAYLOAD="{\\"json\\":{\\"terminalId\\":\\"$(json_escape "$ODIN_TERMINAL_ID")\\",\\"eventType\\":\\"$(json_escape "$EVENT_TYPE")\\",\\"agent\\":{\\"agentId\\":\\"$(json_escape "$ODIN_AGENT_ID")\\",\\"sessionId\\":\\"$(json_escape "$SESSION_ID")\\"}}}"',
		);
		expect(script).toContain(
			"event=$EVENT_TYPE terminalId=$ODIN_TERMINAL_ID agentId=$ODIN_AGENT_ID hookSessionId=$HOOK_SESSION_ID resourceId=$RESOURCE_ID paneId=$ODIN_PANE_ID tabId=$ODIN_TAB_ID workspaceId=$ODIN_WORKSPACE_ID",
		);
		expect(script).toContain('V1_EVENT_TYPE="$EVENT_TYPE"');
		expect(script).toContain('V1_EVENT_TYPE="Stop"');
	});

	it("gives the v2 host-service hook enough time to deliver", () => {
		const script = readNotifyHookTemplate();

		expect(script).toContain(
			'curl -sX POST "$ODIN_HOST_AGENT_HOOK_URL" \\\n    --connect-timeout 2 --max-time 5',
		);
	});

	it("falls back to the v1 Electron hook when v2 is unavailable", () => {
		const script = readNotifyHookTemplate();

		expect(script).toContain(
			'if [ -n "$ODIN_HOST_AGENT_HOOK_URL" ] && [ -n "$ODIN_TERMINAL_ID" ]; then',
		);
		expect(script).toContain(
			'[ -z "$ODIN_TAB_ID" ] && [ -z "$SESSION_ID" ] && [ -z "$ODIN_TERMINAL_ID" ] && exit 0',
		);
		expect(script).toContain("/hook/complete");
		expect(script).toContain("terminalId=$ODIN_TERMINAL_ID");
		expect(script).toContain("ODIN_TAB_ID");
		expect(script).toContain("ODIN_PANE_ID");
	});

	// The bug this covers: one shared port file, two Odin-family apps. The one
	// that loses the preferred port writes its own fallback port into the file
	// and then exits, and the file goes on naming a port nobody answers. Every
	// hook from every live session landed nowhere after that, the board never
	// heard another Start, and mid-turn sessions sat in Needs you claiming
	// "waiting on your input".
	it("falls past a stale port file to a port that answers", async () => {
		const home = mkdtempSync(path.join(tmpdir(), "odin-hook-port-"));
		// Port 1 is nobody's hook server — loopback refuses it immediately.
		writeFileSync(path.join(home, "notifications-port"), "1");

		const hits: string[] = [];
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				hits.push(new URL(request.url).search);
				return new Response("{}");
			},
		});

		try {
			const result = await runNotifyHook(
				{ hook_event_name: "Stop", session_id: "session-1" },
				{
					defaultPort: server.port,
					env: {
						ODIN_HOME_DIR: home,
						ODIN_TAB_ID: "tab-1",
						ODIN_PORT: "",
						ODIN_HOST_AGENT_HOOK_URL: "",
						ODIN_HOOK_DEBUG_LOG: path.join(home, "hooks.log"),
					},
				},
			);

			expect(result.exitCode).toBe(0);
			expect(hits).toHaveLength(1);
			expect(hits[0]).toContain("eventType=Stop");
		} finally {
			server.stop(true);
		}
	});

	it("stops at the first port that answers", async () => {
		const home = mkdtempSync(path.join(tmpdir(), "odin-hook-port-"));
		const hits: string[] = [];
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				hits.push(new URL(request.url).search);
				return new Response("{}");
			},
		});
		writeFileSync(path.join(home, "notifications-port"), String(server.port));

		try {
			const result = await runNotifyHook(
				{ hook_event_name: "Stop", session_id: "session-1" },
				{
					// Never reached: the port file already answered.
					defaultPort: 1,
					env: {
						ODIN_HOME_DIR: home,
						ODIN_TAB_ID: "tab-1",
						ODIN_PORT: "",
						ODIN_HOST_AGENT_HOOK_URL: "",
						ODIN_HOOK_DEBUG_LOG: path.join(home, "hooks.log"),
					},
				},
			);

			expect(result.exitCode).toBe(0);
			expect(hits).toHaveLength(1);
		} finally {
			server.stop(true);
		}
	});

	it("normalizes Grok permission notifications to PermissionRequest", async () => {
		const result = await runNotifyHook({
			hookEventName: "notification",
			notificationType: "permission_prompt",
		});

		expect(result.exitCode).toBe(0);
		expect(result.stderr.toString()).toContain(
			"[notify-hook] event=PermissionRequest",
		);
	});

	it("normalizes Grok ask_user_question notifications to PermissionRequest", async () => {
		const result = await runNotifyHook({
			hookEventName: "notification",
			notificationType: "elicitation_dialog",
		});

		expect(result.exitCode).toBe(0);
		expect(result.stderr.toString()).toContain(
			"[notify-hook] event=PermissionRequest",
		);
	});

	it("ignores unrelated Grok notification subtypes", async () => {
		const result = await runNotifyHook({
			hookEventName: "notification",
			notificationType: "idle_prompt",
		});

		expect(result.exitCode).toBe(0);
		expect(result.stderr.toString()).toBe("");
	});
});

describe("per-agent hook scripts dispatch to v2", () => {
	const buildExpectedV2Payload = (agentIdVar: string) =>
		`PAYLOAD="{\\"json\\":{\\"terminalId\\":\\"$(json_escape "$ODIN_TERMINAL_ID")\\",\\"eventType\\":\\"$(json_escape "$EVENT_TYPE")\\",\\"agent\\":{\\"agentId\\":\\"$(json_escape "$${agentIdVar}")\\",\\"sessionId\\":\\"$(json_escape "$HOOK_SESSION_ID")\\"}}}"`;

	for (const [template, agentIdVar] of [
		["cursor-hook.template.sh", "AGENT_ID"],
		["copilot-hook.template.sh", "ODIN_AGENT_ID"],
		["gemini-hook.template.sh", "ODIN_AGENT_ID"],
	] as const) {
		it(`${template} posts v2 first and falls back to v1`, () => {
			const script = readFileSync(
				path.join(import.meta.dir, "templates", template),
				"utf-8",
			);
			expect(script).toContain(buildExpectedV2Payload(agentIdVar));
			expect(script).toContain('curl -sX POST "$ODIN_HOST_AGENT_HOOK_URL"');
			expect(script).toContain(
				'if [ -n "$ODIN_HOST_AGENT_HOOK_URL" ] && [ -n "$ODIN_TERMINAL_ID" ]; then',
			);
			expect(script).toContain("/hook/complete");
			expect(script).toContain('V1_EVENT_TYPE="$EVENT_TYPE"');
			expect(script).toContain("eventType=$V1_EVENT_TYPE");
			expect(script).toContain("terminalId=$ODIN_TERMINAL_ID");
			expect(script).toContain("ODIN_TAB_ID");
			expect(script).toContain("ODIN_PANE_ID");
		});
	}
});
