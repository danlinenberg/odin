import { connect } from "node:tls";

/**
 * Just enough IMAP to read Gmail with the app password Gmail already uses:
 * one search, one fetch. Gmail's Atom feed only lists unread inbox mail, and
 * a share you opened yesterday is still a share.
 */

/** One untagged response, split at each literal: the text before it and the literal. */
export interface ImapPart {
	prefix: string;
	literal: string | null;
}

const quote = (text: string) =>
	`"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * Runs `commands` in order on one connection and returns each command's
 * untagged responses. A NO or BAD answer rejects with Gmail's own words.
 */
export function imapSession(
	credentials: { address: string; password: string },
	commands: ((previous: ImapPart[][][]) => string)[],
	timeoutMs = 20_000,
): Promise<ImapPart[][][]> {
	return new Promise((resolve, reject) => {
		const socket = connect({
			host: "imap.gmail.com",
			port: 993,
			servername: "imap.gmail.com",
		});
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error("Gmail didn't answer in time"));
		}, timeoutMs);
		const fail = (error: Error) => {
			clearTimeout(timer);
			socket.destroy();
			reject(error);
		};

		const all = [
			() =>
				`LOGIN ${quote(credentials.address)} ${quote(credentials.password.replace(/\s/g, ""))}`,
			...commands,
		];
		const results: ImapPart[][][] = [];
		let step = -1; // -1 = waiting for the server's greeting
		let buffer = Buffer.alloc(0);
		let current: ImapPart[] = [];
		let responses: ImapPart[][] = [];

		const send = () => {
			step++;
			if (step === all.length) {
				socket.end("z LOGOUT\r\n");
				clearTimeout(timer);
				resolve(results.slice(1));
				return;
			}
			responses = [];
			socket.write(`a${step} ${all[step](results.slice(1))}\r\n`);
		};

		const onLine = (line: string) => {
			if (step === -1) {
				if (line.startsWith("* OK")) send();
				else fail(new Error(`Gmail refused the connection: ${line}`));
				return;
			}
			const tag = `a${step} `;
			if (line.startsWith(tag)) {
				const status = line.slice(tag.length);
				if (!status.startsWith("OK")) {
					fail(new Error(status.replace(/^(NO|BAD)\s*/, "")));
					return;
				}
				results.push(responses);
				send();
			} else if (line.startsWith("*")) {
				current.push({ prefix: line, literal: null });
				responses.push(current);
				current = [];
			}
		};

		socket.on("data", (chunk: Buffer) => {
			buffer = Buffer.concat([buffer, chunk]);
			for (;;) {
				const end = buffer.indexOf("\r\n");
				if (end < 0) return;
				const line = buffer.subarray(0, end).toString("utf8");
				const size = line.match(/\{(\d+)\}$/);
				if (size) {
					const n = Number(size[1]);
					if (buffer.length < end + 2 + n) return;
					current.push({
						prefix: line,
						literal: buffer.subarray(end + 2, end + 2 + n).toString("latin1"),
					});
					buffer = buffer.subarray(end + 2 + n);
					continue;
				}
				buffer = buffer.subarray(end + 2);
				if (current.length > 0) {
					// The tail after a literal closes the response it belongs to.
					current.push({ prefix: line, literal: null });
					responses.push(current);
					current = [];
				} else onLine(line);
			}
		});
		socket.on("error", fail);
		socket.on("close", () => {
			if (step < all.length) fail(new Error("Gmail closed the connection"));
		});
	});
}

/** The mailbox Gmail flags \All ("All Mail", in whatever language the account uses). */
export function allMailbox(listed: ImapPart[][]): string {
	for (const [part] of listed) {
		const match = part.prefix.match(
			/\(([^)]*\\All[^)]*)\)\s+"[^"]*"\s+"(.*)"$/,
		);
		if (match) return match[2];
	}
	return "[Gmail]/All Mail";
}

/** RFC 2047 words (=?UTF-8?B?...?=) in a header, decoded. */
export function decodeHeader(value: string): string {
	return value
		.replace(/\r?\n[ \t]+/g, " ")
		.replace(/(\?=)\s+(=\?)/g, "$1$2")
		.replace(
			/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
			(_, charset: string, encoding: string, text: string) => {
				const bytes =
					encoding.toUpperCase() === "B"
						? Buffer.from(text, "base64")
						: Buffer.from(
								text
									.replace(/_/g, " ")
									.replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) =>
										String.fromCharCode(Number.parseInt(hex, 16)),
									),
								"latin1",
							);
				return decode(bytes, charset);
			},
		)
		.trim();
}

function decode(bytes: Buffer, charset: string): string {
	try {
		return new TextDecoder(charset).decode(bytes);
	} catch {
		return bytes.toString("utf8");
	}
}

/** A MIME part's body (as raw latin1 bytes) decoded by its own headers. */
export function decodeBody(mimeHeaders: string, raw: string): string {
	const encoding =
		mimeHeaders.match(/content-transfer-encoding:\s*([\w-]+)/i)?.[1] ?? "";
	const charset = mimeHeaders.match(/charset="?([\w-]+)"?/i)?.[1] ?? "utf-8";
	let bytes = Buffer.from(raw, "latin1");
	if (/^base64$/i.test(encoding)) {
		bytes = Buffer.from(raw.replace(/\s/g, ""), "base64");
	} else if (/^quoted-printable$/i.test(encoding)) {
		bytes = Buffer.from(
			raw
				.replace(/=\r?\n/g, "")
				.replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) =>
					String.fromCharCode(Number.parseInt(hex, 16)),
				),
			"latin1",
		);
	}
	return decode(bytes, charset);
}

/** One FETCH response's sections by name ("HEADER.FIELDS (FROM SUBJECT)", "1", ...). */
export function fetchSections(response: ImapPart[]): {
	uid: string | null;
	internalDate: string | null;
	sections: Record<string, string>;
} {
	const sections: Record<string, string> = {};
	const head = response.map((part) => part.prefix).join(" ");
	for (const part of response) {
		const name = part.prefix.match(/BODY\[([^\]]*)\]\s*\{\d+\}$/)?.[1];
		if (name !== undefined && part.literal !== null) {
			sections[name.toUpperCase()] = part.literal;
		}
	}
	return {
		uid: head.match(/UID (\d+)/)?.[1] ?? null,
		internalDate: head.match(/INTERNALDATE "([^"]+)"/)?.[1] ?? null,
		sections,
	};
}

/** One email found by searchGmail: its headers decoded and its first part as text. */
export interface FoundEmail {
	subject: string;
	from: string;
	body: string;
	receivedAt: string | null;
}

/**
 * Every email in All Mail matching a Gmail search (`from:x newer_than:14d`),
 * newest first, capped at `limit`. Reads only, and marks nothing read.
 */
export async function searchGmail(
	credentials: { address: string; password: string },
	query: string,
	limit = 100,
): Promise<FoundEmail[]> {
	const [, , , fetched] = await imapSession(credentials, [
		() => 'LIST "" "*"',
		([listed]) => `EXAMINE ${quote(allMailbox(listed))}`,
		() => `UID SEARCH X-GM-RAW ${quote(query)}`,
		([, , searched]) => {
			const uids = searched
				.map((response) => response[0].prefix)
				.find((line) => line.startsWith("* SEARCH"))
				?.slice("* SEARCH".length)
				.trim()
				.split(/\s+/)
				.filter(Boolean)
				.slice(-limit);
			if (!uids?.length) return "NOOP";
			return `UID FETCH ${uids.join(",")} (UID INTERNALDATE BODY.PEEK[HEADER.FIELDS (FROM SUBJECT)] BODY.PEEK[1.MIME] BODY.PEEK[1])`;
		},
	]);
	return fetched
		.map(fetchSections)
		.filter(({ sections }) => sections["1"] !== undefined)
		.map(({ internalDate, sections }) => {
			const headers = sections["HEADER.FIELDS (FROM SUBJECT)"] ?? "";
			const field = (name: string) =>
				decodeHeader(
					// Literals arrive as latin1; a raw (unencoded) UTF-8 header needs re-reading.
					Buffer.from(
						headers.match(
							new RegExp(`^${name}:(.*(?:\\r?\\n[ \\t].*)*)`, "im"),
						)?.[1] ?? "",
						"latin1",
					).toString("utf8"),
				);
			const at = internalDate
				? Date.parse(internalDate.replace(/-/g, " "))
				: Number.NaN;
			return {
				subject: field("Subject"),
				from: field("From"),
				body: decodeBody(sections["1.MIME"] ?? "", sections["1"]),
				receivedAt: Number.isNaN(at) ? null : new Date(at).toISOString(),
			};
		})
		.sort((a, b) => (b.receivedAt ?? "").localeCompare(a.receivedAt ?? ""));
}
