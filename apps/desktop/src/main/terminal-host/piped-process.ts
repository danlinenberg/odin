import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { IPty } from "node-pty";

type Listener<T> = (value: T) => void;

/**
 * A program on plain pipes behind node-pty's interface, for one that gets no
 * terminal on Windows anyway: Odin.exe running remote-shell is a GUI program.
 * Its stdout and stderr are the pane's output, keys go to its stdin as they
 * are, and the pane's size goes to it as ODIN_PTY_COLS/ROWS, then over the
 * IPC channel on each resize.
 */
export function spawnPiped(
	file: string,
	args: string[],
	options: {
		cwd: string;
		cols: number;
		rows: number;
		env: Record<string, string>;
	},
): IPty {
	const child = spawn(file, args, {
		cwd: options.cwd,
		env: {
			...options.env,
			ODIN_PTY_COLS: String(options.cols),
			ODIN_PTY_ROWS: String(options.rows),
		},
		stdio: ["pipe", "pipe", "pipe", "ipc"],
		windowsHide: true,
	});
	const onData: Listener<string>[] = [];
	const onExit: Listener<{ exitCode: number; signal?: number }>[] = [];
	const emit = (text: string) => {
		if (text) for (const listener of onData) listener(text);
	};
	for (const stream of [child.stdout, child.stderr]) {
		// One decoder per stream, so a character split across reads stays whole.
		const decoder = new StringDecoder("utf8");
		stream?.on("data", (chunk: Buffer) => emit(decoder.write(chunk)));
	}
	child.on("error", (error) => emit(`\r\nOdin: ${error.message}\r\n`));
	// "close", not "exit": it comes once the output is all read.
	child.on("close", (code) => {
		for (const listener of onExit) listener({ exitCode: code ?? 1 });
	});
	const subscribe =
		<T>(listeners: Listener<T>[]) =>
		(listener: Listener<T>) => {
			listeners.push(listener);
			return {
				dispose: () => {
					listeners.splice(listeners.indexOf(listener), 1);
				},
			};
		};
	return {
		pid: child.pid ?? 0,
		cols: options.cols,
		rows: options.rows,
		process: file,
		handleFlowControl: false,
		onData: subscribe(onData),
		onExit: subscribe(onExit),
		write: (data: string) => {
			child.stdin?.write(data);
		},
		resize: (cols: number, rows: number) => {
			if (child.connected) child.send({ cols, rows });
		},
		kill: (signal?: string) => {
			child.kill(signal as NodeJS.Signals | undefined);
		},
		pause: () => {
			child.stdout?.pause();
			child.stderr?.pause();
		},
		resume: () => {
			child.stdout?.resume();
			child.stderr?.resume();
		},
		clear: () => {},
	} as unknown as IPty;
}
