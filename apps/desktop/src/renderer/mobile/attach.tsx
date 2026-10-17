import { useRef, useState } from "react";
import { LuMic, LuPaperclip, LuSquare, LuX } from "react-icons/lu";
import type { Pairing } from "./pair-link";
import { speechAvailable, type useSpeech } from "./speech";

/**
 * Photos, videos and files from the phone: iOS's own picker (library, camera,
 * Files), each one uploaded to the Mac as soon as it's picked, so Send only
 * waits for the ones still going. The reply carries the saved paths.
 */

type Upload = {
	id: number;
	name: string;
	preview?: string;
	path?: string;
	error?: string;
};

let nextId = 0;

/** The extension the Mac saves it under: the name's, else the MIME subtype. */
const extensionOf = (file: File) =>
	(
		/\.([a-z0-9]{1,8})$/i.exec(file.name)?.[1] ??
		file.type.split("/")[1]?.replace(/^quicktime$/, "mov") ??
		"bin"
	).toLowerCase();

export function useUploads(pairing: Pairing | null) {
	const [files, setFiles] = useState<Upload[]>([]);
	const update = (id: number, patch: Partial<Upload>) =>
		setFiles((all) => all.map((f) => (f.id === id ? { ...f, ...patch } : f)));

	async function upload(file: File, id: number) {
		try {
			const reply = await fetch(
				`${pairing?.base ?? ""}/upload?ext=${extensionOf(file)}`,
				{
					method: "POST",
					headers: { authorization: `Bearer ${pairing?.token ?? ""}` },
					body: file,
				},
			);
			if (!reply.ok) throw new Error(`Upload failed (${reply.status})`);
			const { path } = (await reply.json()) as { path: string };
			update(id, { path });
		} catch (failure) {
			update(id, {
				error: failure instanceof Error ? failure.message : "Upload failed",
			});
		}
	}

	function add(list: FileList | null) {
		for (const file of Array.from(list ?? [])) {
			const id = nextId++;
			setFiles((all) => [
				...all,
				{
					id,
					name: file.name,
					preview: file.type.startsWith("image/")
						? URL.createObjectURL(file)
						: undefined,
				},
			]);
			void upload(file, id);
		}
	}

	return {
		files,
		add,
		paths: files.flatMap((f) => (f.path ? [f.path] : [])),
		uploading: files.some((f) => !f.path && !f.error),
		remove: (id: number) => setFiles((all) => all.filter((f) => f.id !== id)),
		clear: () => setFiles([]),
	};
}

/** The picked files above the text box: a thumbnail or a name, and ✕. */
export function UploadChips({
	uploads,
}: {
	uploads: ReturnType<typeof useUploads>;
}) {
	if (uploads.files.length === 0) return null;
	return (
		<div className="flex gap-2 overflow-x-auto px-2.5 pt-2">
			{uploads.files.map((file) => (
				<div
					key={file.id}
					className="relative flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-[10px] border border-border bg-card text-[10px] text-muted-foreground"
				>
					{file.preview ? (
						<img src={file.preview} alt="" className="size-full object-cover" />
					) : (
						<span className="line-clamp-2 break-all px-1">{file.name}</span>
					)}
					{!file.path && (
						<span
							className={`absolute inset-0 flex items-center justify-center bg-background/60 text-[10px] ${file.error ? "text-danger" : "text-foreground"}`}
						>
							{file.error ? "Failed" : "…"}
						</span>
					)}
					<button
						type="button"
						aria-label={`Remove ${file.name}`}
						onClick={() => uploads.remove(file.id)}
						className="absolute top-0.5 right-0.5 flex size-5 items-center justify-center rounded-full bg-background/80 text-[11px]"
					>
						<LuX className="size-3" />
					</button>
				</div>
			))}
		</div>
	);
}

/** 📎: iOS offers Photo Library, Take Photo or Video, and Choose File. */
export function AttachButton({
	uploads,
}: {
	uploads: ReturnType<typeof useUploads>;
}) {
	const input = useRef<HTMLInputElement>(null);
	return (
		<>
			<button
				type="button"
				aria-label="Attach photos or files"
				onClick={() => input.current?.click()}
				className="flex size-10 shrink-0 items-center justify-center rounded-full border border-border bg-secondary text-lg"
			>
				<LuPaperclip className="size-5" />
			</button>
			<input
				ref={input}
				type="file"
				multiple
				className="hidden"
				onChange={(event) => {
					uploads.add(event.target.files);
					event.target.value = "";
				}}
			/>
		</>
	);
}

/** 🎤: tap to talk, tap again - the words land in the box. */
export function MicButton({
	speech,
}: {
	speech: ReturnType<typeof useSpeech>;
}) {
	if (!speechAvailable) return null;
	return (
		<button
			type="button"
			aria-label={speech.listening ? "Stop dictation" : "Dictate"}
			onClick={() => void speech.toggle()}
			className={`flex size-10 shrink-0 items-center justify-center rounded-full border text-lg ${
				speech.listening
					? "animate-pulse border-danger bg-danger/20"
					: "border-border bg-secondary"
			}`}
		>
			{speech.listening ? (
				<LuSquare className="size-4 fill-current" />
			) : (
				<LuMic className="size-5" />
			)}
		</button>
	);
}

/** Appends dictated words to what's already typed. */
export const appendWords = (text: string, words: string) =>
	text.trim() ? `${text.trimEnd()} ${words}` : words;
