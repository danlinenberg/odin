import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { app } from "electron";
import { readOdinConfig, updateOdinConfig } from "lib/trpc/routers/odin-config";
import {
	DOUBLE_TAP_MODIFIERS,
	type DoubleTapModifier,
} from "shared/double-tap-keys";

/**
 * Double-tap a modifier to show or hide Odin, from any app. A tiny Swift
 * helper watches the session's key events with a global NSEvent monitor -
 * the level Synergy and other software keyboards inject at, which Karabiner
 * never sees - reports every bare double-tap, and toggles this process on the
 * chosen one. It raises Odin itself, falling back to `open`, because macOS
 * won't let a background app pull itself to the front.
 *
 * Synergy sends modifier changes with key code 0 and may remap them, so the
 * setting is whichever modifier arrived when you recorded it, either side.
 *
 * ponytail: compiled with swiftc on first use (Xcode command line tools);
 * ship a prebuilt binary if Odin ever runs on a machine without them.
 */
const SOURCE = String.raw`
import Cocoa

let masks: [(String, NSEvent.ModifierFlags)] = [("command", .command), ("option", .option), ("control", .control), ("shift", .shift)]
guard CommandLine.arguments.count == 3, let pid = pid_t(CommandLine.arguments[2]) else { exit(2) }
let target = CommandLine.arguments[1]
let all: NSEvent.ModifierFlags = [.command, .option, .control, .shift]
// How long a tap may be held, and how soon the second must follow the
// first. Generous: Synergy adds lag to both.
let maxHold: TimeInterval = 0.6
let maxGap: TimeInterval = 0.8

var pressed: String? = nil
var pressedAt: TimeInterval = 0
var lastTap: String? = nil
var lastTapAt: TimeInterval = 0

func say(_ line: String) { print(line); fflush(stdout) }

func toggle() {
	guard let odin = NSRunningApplication(processIdentifier: pid) else { exit(0) }
	if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid {
		odin.hide()
		return say("hidden")
	}
	odin.unhide()
	odin.activate(options: [.activateAllWindows])
	DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
		if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid { return say("shown") }
		if let url = odin.bundleURL {
			let open = Process()
			open.executableURL = URL(fileURLWithPath: "/usr/bin/open")
			open.arguments = [url.path]
			try? open.run()
		}
		say("shown")
	}
}

say(AXIsProcessTrusted() ? "ready" : "untrusted")
NSEvent.addGlobalMonitorForEvents(matching: [.flagsChanged, .keyDown, .leftMouseDown, .rightMouseDown]) { e in
	// Not e.timestamp: Synergy-injected events can carry 0.
	let now = ProcessInfo.processInfo.systemUptime
	guard e.type == .flagsChanged else { pressed = nil; lastTap = nil; return }
	let held = e.modifierFlags.intersection(all)
	if let name = masks.first(where: { held == $0.1 })?.0 {
		pressed = name
		pressedAt = now
	} else if held.isEmpty, let name = pressed, now - pressedAt < maxHold {
		if lastTap == name && now - lastTapAt < maxGap {
			lastTap = nil
			say("double \(name)")
			if name == target { toggle() }
		} else {
			lastTap = name
			lastTapAt = now
		}
		pressed = nil
	} else {
		pressed = nil
	}
}
NSApplication.shared.run()
`;

async function helperBinary(): Promise<string> {
	const dir = join(
		process.env.ODIN_HOME_DIR ?? join(homedir(), ".odin"),
		"bin",
	);
	const hash = createHash("sha256").update(SOURCE).digest("hex").slice(0, 12);
	const bin = join(dir, `double-tap-${hash}`);
	if (existsSync(bin)) return bin;
	mkdirSync(dir, { recursive: true });
	writeFileSync(`${bin}.swift`, SOURCE);
	await promisify(execFile)("/usr/bin/swiftc", [
		"-O",
		`${bin}.swift`,
		"-o",
		bin,
	]);
	return bin;
}

let helper: ChildProcess | null = null;
let onDouble: ((modifier: DoubleTapModifier) => void) | null = null;

async function runHelper(target: DoubleTapModifier | "none"): Promise<void> {
	helper?.kill();
	helper = null;
	if (process.platform !== "darwin") return;
	const child = spawn(await helperBinary(), [target, String(process.pid)], {
		stdio: ["ignore", "pipe", "inherit"],
	});
	helper = child;
	child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
		for (const line of chunk.split("\n").filter(Boolean)) {
			if (line === "untrusted")
				console.warn("[double-tap] needs Accessibility");
			// Activation alone doesn't restore a minimized or closed window.
			if (line === "shown") app.emit("activate");
			const modifier = line.replace("double ", "") as DoubleTapModifier;
			if (
				line.startsWith("double ") &&
				DOUBLE_TAP_MODIFIERS.includes(modifier)
			) {
				onDouble?.(modifier);
			}
		}
	});
	child.on("exit", () => {
		if (helper === child) helper = null;
	});
}

export function getDoubleTapModifier(): DoubleTapModifier | null {
	const saved = readOdinConfig().doubleTapModifier;
	return DOUBLE_TAP_MODIFIERS.find((m) => m === saved) ?? null;
}

/** Call once after app.whenReady(). */
export function startDoubleTap(): void {
	const modifier = getDoubleTapModifier();
	if (modifier) void runHelper(modifier);
}

export async function setDoubleTapModifier(
	modifier: DoubleTapModifier | null,
): Promise<void> {
	updateOdinConfig({ doubleTapModifier: modifier ?? undefined });
	if (modifier) await runHelper(modifier);
	else {
		helper?.kill();
		helper = null;
	}
}

/**
 * Waits for the next bare double-tap of any modifier and saves it. The
 * helper runs without a target meanwhile, so recording doesn't toggle Odin.
 */
export async function recordDoubleTap(): Promise<DoubleTapModifier> {
	await runHelper("none");
	try {
		const modifier = await new Promise<DoubleTapModifier>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("No double-tap within 15 seconds")),
				15_000,
			);
			onDouble = (m) => {
				clearTimeout(timer);
				resolve(m);
			};
		});
		await setDoubleTapModifier(modifier);
		return modifier;
	} finally {
		onDouble = null;
		const saved = getDoubleTapModifier();
		if (!saved) helper?.kill();
		else if (helper?.spawnargs[1] === "none") await runHelper(saved);
	}
}

app.on("will-quit", () => helper?.kill());
