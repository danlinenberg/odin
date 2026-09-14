#!/usr/bin/env bun
/**
 * UI health check for the dan-views fork, over CDP.
 *
 * Run the dev app with RENDERER_REMOTE_DEBUG_PORT=9223, then:
 *   bun tools/ui-check.mjs [--shots-dir /tmp]
 *
 * Connects to the renderer, signs in as dev if needed, visits /dan/board and
 * /dan/slack, asserts each view's key elements, and saves a screenshot per
 * view. Exits 0 when every check passes, 1 otherwise; prints a JSON report.
 */

const PORT = Number(process.env.RENDERER_REMOTE_DEBUG_PORT ?? 9223);
const shotsDir =
	process.argv.includes("--shots-dir") &&
	process.argv[process.argv.indexOf("--shots-dir") + 1]
		? process.argv[process.argv.indexOf("--shots-dir") + 1]
		: ".";

// ---------------------------------------------------------------------------
// CDP plumbing
// ---------------------------------------------------------------------------

async function findRendererTarget() {
	const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
	const targets = await response.json();
	const page = targets.find(
		(target) =>
			target.type === "page" &&
			/localhost:\d+\/#/.test(target.url ?? "") &&
			!/devtools/.test(target.url ?? ""),
	);
	if (!page) {
		throw new Error(
			`No renderer page target on port ${PORT}. Targets: ${targets
				.map((target) => `${target.type}:${target.url}`)
				.join(", ")}`,
		);
	}
	return page;
}

function connect(wsUrl) {
	return new Promise((resolvePromise, rejectPromise) => {
		const socket = new WebSocket(wsUrl);
		let nextId = 1;
		const pending = new Map();
		socket.onopen = () =>
			resolvePromise({
				send(method, params = {}) {
					const id = nextId++;
					return new Promise((resolveCall, rejectCall) => {
						pending.set(id, { resolveCall, rejectCall });
						socket.send(JSON.stringify({ id, method, params }));
					});
				},
				close: () => socket.close(),
			});
		socket.onerror = (event) => rejectPromise(new Error(`WS error: ${event}`));
		socket.onmessage = (event) => {
			const message = JSON.parse(event.data);
			if (message.id && pending.has(message.id)) {
				const { resolveCall, rejectCall } = pending.get(message.id);
				pending.delete(message.id);
				if (message.error) rejectCall(new Error(message.error.message));
				else resolveCall(message.result);
			}
		};
	});
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let cdp;

async function evaluate(expression) {
	const result = await cdp.send("Runtime.evaluate", {
		expression,
		returnByValue: true,
		awaitPromise: true,
	});
	if (result.exceptionDetails) {
		throw new Error(
			`eval failed: ${result.exceptionDetails.exception?.description ?? "?"}`,
		);
	}
	return result.result.value;
}

async function waitFor(expression, timeoutMs = 15000, label = expression) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (await evaluate(expression)) return true;
		await new Promise((resolveSleep) => setTimeout(resolveSleep, 400));
	}
	throw new Error(`timeout waiting for: ${label}`);
}

async function screenshot(name) {
	const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
	const path = `${shotsDir}/${name}.png`;
	await Bun.write(path, Buffer.from(data, "base64"));
	return path;
}

const BODY_TEXT = "document.body.innerText";

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

const report = { checks: [], screenshots: [] };
function check(name, ok, detail = "") {
	report.checks.push({ name, ok, detail });
}

try {
	const target = await findRendererTarget();
	cdp = await connect(target.webSocketDebuggerUrl);
	await cdp.send("Page.enable");
	await cdp.send("Runtime.enable");

	// -- sign in (dev) if the sign-in screen is up ---------------------------
	const needsSignIn = await evaluate(
		`${BODY_TEXT}.includes("Sign in as dev")`,
	);
	if (needsSignIn) {
		await evaluate(`
			[...document.querySelectorAll("button")]
				.find((el) => el.textContent.includes("Sign in as dev"))?.click()
		`);
		await waitFor(
			`!${BODY_TEXT}.includes("Sign in as dev")`,
			20000,
			"dev sign-in to complete",
		);
	}
	check("signed-in", true, needsSignIn ? "clicked dev sign-in" : "already in");

	// Navigate by clicking real nav buttons — TanStack Router ignores raw
	// location.hash writes. Both the stock sidebar ("Dev board") and the dan
	// shell rail ("Dev Board") carry aria-labels. Click inside the wait loop:
	// right after boot the first attempts can run before React has mounted.
	const navTo = async (labels, marker) => {
		const start = Date.now();
		while (Date.now() - start < 20000) {
			if (await evaluate(`${BODY_TEXT}.includes(${JSON.stringify(marker)})`)) {
				return;
			}
			await evaluate(`
				[...document.querySelectorAll("button")]
					.find((el) => ${JSON.stringify(labels)}.includes(el.getAttribute("aria-label")))
					?.click()
			`);
			await new Promise((resolveSleep) => setTimeout(resolveSleep, 600));
		}
		throw new Error(`timeout navigating to: ${marker}`);
	};

	// -- Dev Board -----------------------------------------------------------
	await navTo(["Dev board", "Dev Board"], "Dev Board");
	const boardState = await evaluate(`(() => {
		// CSS uppercases the column headers, so compare case-insensitively
		const text = ${BODY_TEXT}.toUpperCase();
		return {
			columns: ["WORKING", "NEEDS INPUT", "REVIEW", "FAILED"].filter((c) =>
				text.includes(c),
			),
			hasNewTaskInput: !!document.querySelector(
				'input[placeholder^="New task"]',
			),
			hasWorkspaceChip: text.includes("WORKSPACE:"),
			cardCount: document.querySelectorAll('[role="button"][tabindex]').length,
		};
	})()`);
	check(
		"board-columns",
		boardState.columns.length === 4,
		`found: ${boardState.columns.join(", ")}`,
	);
	check("board-new-task-input", boardState.hasNewTaskInput);
	check("board-workspace-chip", boardState.hasWorkspaceChip);
	check("board-cards", true, `${boardState.cardCount} card(s)`);
	report.screenshots.push(await screenshot("ui-check-board"));

	// -- Slack Queue ----------------------------------------------------------
	await navTo(["Slack queue", "Slack Queue"], "Slack Queue");
	// Force a fresh fetch (the app rehydrates persisted caches) and wait for
	// it: fresh data renders the DB title instead of the "…" placeholder.
	await evaluate(`
		[...document.querySelectorAll("button")]
			.find((el) => el.textContent.includes("Sync"))?.click()
	`);
	await waitFor(
		`!${BODY_TEXT}.includes("Notion DB: …") || ${BODY_TEXT}.includes("No Notion token") || ${BODY_TEXT}.includes("Notion query failed")`,
		15000,
		"fresh notion data (db title rendered)",
	).catch(() => {});
	const slackState = await evaluate(`(() => {
		const text = ${BODY_TEXT};
		return {
			tokenMissing: text.includes("No Notion token"),
			dbMissing: text.includes("No database configured"),
			notionError: text.includes("Notion query failed") ||
				text.includes("object_not_found") ||
				text.includes("Could not find database"),
			emptyDb: text.includes("No rows in this database"),
			fresh: !text.includes("Notion DB: …"),
			noLinkRows: (text.match(/no Slack link/g) ?? []).length,
			startButtons: [...document.querySelectorAll("button")].filter((el) =>
				el.textContent.includes("Start session"),
			).length,
			doneButtons: [...document.querySelectorAll("button")].filter((el) =>
				el.textContent.includes("Done"),
			).length,
		};
	})()`);
	check(
		"slack-done-buttons",
		slackState.doneButtons > 0 || slackState.startButtons === 0,
		`${slackState.doneButtons} ✓ Done button(s)`,
	);
	check("slack-fresh-data", slackState.fresh, "db title rendered");
	check(
		"slack-only-slack-rows",
		slackState.noLinkRows === 0,
		`${slackState.noLinkRows} row(s) without a Slack link`,
	);
	check("slack-token-present", !slackState.tokenMissing);
	check("slack-db-configured", !slackState.dbMissing);
	check(
		"slack-rows",
		slackState.startButtons > 0 || slackState.emptyDb || slackState.notionError,
		slackState.notionError
			? "notion error shown (likely: DB not shared with integration)"
			: `${slackState.startButtons} row(s)`,
	);
	report.screenshots.push(await screenshot("ui-check-slack"));
} catch (error) {
	check("fatal", false, error instanceof Error ? error.message : String(error));
}

// ---------------------------------------------------------------------------

const failed = report.checks.filter((item) => !item.ok);
report.verdict = failed.length === 0 ? "PASS" : "FAIL";
console.log(JSON.stringify(report, null, 2));
cdp?.close();
process.exit(failed.length === 0 ? 0 : 1);
