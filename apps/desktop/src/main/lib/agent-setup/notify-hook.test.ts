import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SHELL_RULE } from "shared/constants";
import { getShellRuleScriptContent, NOTIFY_SCRIPT_MARKER } from "./notify-hook";

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
		expect(NOTIFY_SCRIPT_MARKER).toBe("# Odin agent notification hook v10");
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
		// Port 1 is nobody's hook server - loopback refuses it immediately.
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

	it.each([
		["Done.\n\nACTION ITEMS:\n1. Restart Odin dev.", "PermissionRequest"],
		["Done.\n\n**ACTION ITEMS**\n- Merge #12", "PermissionRequest"],
		["Done.\n\nACTION ITEMS: none - nothing left.", "Stop"],
		["Done.\n\nAction items: None, all merged.", "Stop"],
		["Quoting ACTION ITEMS:\n1. x\n\nACTION ITEMS: none", "Stop"],
		["No closing section at all.", "Stop"],
		["Found it.\n\nWant me to push the fix?", "PermissionRequest"],
		["Want me to?\n\nNo, done: merged it.", "Stop"],
	])("a Stop ending %j reports %s", async (message, expected) => {
		const result = await runNotifyHook({
			hook_event_name: "Stop",
			last_assistant_message: message,
		});

		expect(result.stderr.toString()).toContain(
			`[notify-hook] event=${expected} `,
		);
	});

	it("keeps a Stop Working while a background agent is still out", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "odin-bg-agents-"));
		const transcript = path.join(dir, "session.jsonl");
		const launch = (id: string) =>
			JSON.stringify({
				toolUseResult: { isAsync: true, status: "async_launched", agentId: id },
			});
		const stopOn = async (lines: string[]) => {
			writeFileSync(transcript, `${lines.join("\n")}\n`);
			const result = await runNotifyHook({
				hook_event_name: "Stop",
				transcript_path: transcript,
				last_assistant_message: "Waiting.\n\nACTION ITEMS:\n1. Wait.",
			});
			return result.stderr.toString();
		};
		mkdirSync(path.join(dir, "session", "subagents"), { recursive: true });
		writeFileSync(path.join(dir, "session", "subagents", "agent-a1.jsonl"), "");

		expect(await stopOn([launch("a1")])).toContain("event=Start ");
		// Finished: its task-notification is in the transcript.
		expect(await stopOn([launch("a1"), "<task-id>a1</task-id>"])).toContain(
			"event=PermissionRequest ",
		);
		// No live transcript for it: a killed session's agent, not a running one.
		expect(await stopOn([launch("gone")])).toContain(
			"event=PermissionRequest ",
		);
	});

	it("keeps a Stop Working while a background Bash is still running", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "odin-bg-bash-"));
		const transcript = path.join(dir, "session.jsonl");
		const out = path.join(dir, "tasks", "b1.output");
		mkdirSync(path.dirname(out), { recursive: true });
		writeFileSync(out, "");
		const launch = JSON.stringify({
			message: { content: `Output is being written to: ${out}. You will…` },
			toolUseResult: { backgroundTaskId: "b1" },
		});
		const stopOn = async (lines: string[]) => {
			writeFileSync(transcript, `${lines.join("\n")}\n`);
			const result = await runNotifyHook({
				hook_event_name: "Stop",
				transcript_path: transcript,
				last_assistant_message: "Waiting on CI.\n\nACTION ITEMS:\n1. Wait.",
			});
			return result.stderr.toString();
		};
		// The poll holds its output file open while it runs.
		const poll = Bun.spawn({
			cmd: ["bash", "-c", `exec >>"${out}"; exec sleep 30`],
		});
		try {
			await Bun.sleep(200);
			expect(await stopOn([launch])).toContain("event=Start ");
			expect(await stopOn([launch, "<task-id>b1</task-id>"])).toContain(
				"event=PermissionRequest ",
			);
		} finally {
			poll.kill();
			await poll.exited;
		}
		// Gone without a notification (killed): nobody holds the file.
		expect(await stopOn([launch])).toContain("event=PermissionRequest ");
	});

	it("drops every event from a claude running under another claude", async () => {
		// A Stop hook's own `claude -p` inherits the card's env. Name two bash
		// layers `claude` so the hook sees that ancestry.
		const hook = readNotifyHookTemplate()
			.replaceAll("{{MARKER}}", NOTIFY_SCRIPT_MARKER)
			.replaceAll("{{DEFAULT_PORT}}", "48763");
		const child = Bun.spawn({
			cmd: ["bash", "-c", 'exec -a claude bash -c "$L1"'],
			env: {
				...process.env,
				ODIN_AGENT_ID: "claude",
				ODIN_DEBUG_HOOKS: "1",
				HOOK: hook,
				L1: '(exec -a claude bash -c "$L2"); true',
				L2: 'bash -c "$HOOK"; true',
			},
			stdin: Buffer.from(
				JSON.stringify({
					hook_event_name: "Stop",
					last_assistant_message: "Summary.",
				}),
			),
			stderr: "pipe",
		});
		const stderr = await new Response(child.stderr).text();
		expect(await child.exited).toBe(0);
		expect(stderr).not.toContain("[notify-hook] event=");
	});

	it.each([
		// A hook's detached `claude -p` (Popen start_new_session) has no claude
		// above it to find, and no terminal either; a card's claude has its PTY.
		["drops a lone claude with no terminal", [], false],
		["keeps a lone claude on a terminal", ["script", "-q", "/dev/null"], true],
	])("%s", async (_name, wrap, reported) => {
		const hook = readNotifyHookTemplate()
			.replaceAll("{{MARKER}}", NOTIFY_SCRIPT_MARKER)
			.replaceAll("{{DEFAULT_PORT}}", "48763");
		// Detached, so a claude running this suite isn't an ancestor to find.
		const detach = ["perl", "-e", "fork and exit; exec @ARGV"];
		const child = Bun.spawn({
			cmd: [...detach, ...wrap, "bash", "-c", 'exec -a claude bash -c "$L1"'],
			env: {
				...process.env,
				LC_ALL: "C",
				ODIN_HOME_DIR: tmpdir(),
				ODIN_PORT: "48763",
				ODIN_HOST_AGENT_HOOK_URL: "",
				ODIN_AGENT_ID: "claude",
				ODIN_DEBUG_HOOKS: "1",
				ODIN_HOOK_DEBUG_LOG: "/dev/null",
				HOOK: hook,
				L1: 'printf %s "$IN" | bash -c "$HOOK" 2>&1; true',
				IN: JSON.stringify({ hook_event_name: "Stop", session_id: "s-1" }),
			},
			stdin: "ignore",
			stdout: "pipe",
		});
		const output = await new Response(child.stdout).text();
		expect(output.includes("[notify-hook] event=Stop ")).toBe(reported);
	});

	it("drops a claude event that carries no session_id", async () => {
		const input = { hook_event_name: "Stop" };
		const env = { ODIN_AGENT_ID: "claude" };
		const bare = await runNotifyHook(input, { env });
		expect(bare.stderr).not.toContain("[notify-hook] event=");
		const real = await runNotifyHook({ ...input, session_id: "s-1" }, { env });
		expect(real.stderr).toContain("[notify-hook] event=Stop ");
	});

	it("a Stop without last_assistant_message stays Stop", async () => {
		const result = await runNotifyHook({ hook_event_name: "Stop" });
		expect(result.stderr.toString()).toContain("[notify-hook] event=Stop ");
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

describe("shell rule SessionStart hook", () => {
	const run = (env: Record<string, string>) =>
		Bun.spawnSync({
			cmd: ["bash", "-c", getShellRuleScriptContent()],
			env: { PATH: process.env.PATH ?? "", ...env },
		});

	it("hands a session inside Odin the Shell rule as SessionStart context", () => {
		const out = run({ ODIN_PANE_ID: "pane-1", ODIN_PORT: "51741" });
		expect(out.exitCode).toBe(0);
		expect(JSON.parse(out.stdout.toString())).toEqual({
			hookSpecificOutput: {
				hookEventName: "SessionStart",
				additionalContext: SHELL_RULE,
			},
		});
	});

	it("says nothing outside Odin, where there's no Shell to run in", () => {
		const out = run({});
		expect(out.exitCode).toBe(0);
		expect(out.stdout.toString()).toBe("");
	});
});
