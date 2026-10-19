import { useRef, useState } from "react";
import {
	LuArrowUp,
	LuCamera,
	LuLoaderCircle,
	LuMic,
	LuPlus,
	LuSquare,
	LuX,
} from "react-icons/lu";
import type { OdinFetch } from "./odin-fetch";
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

/** `send` is the app's fetch to Odin (main.tsx). */
export function useUploads(send: OdinFetch) {
	const [files, setFiles] = useState<Upload[]>([]);
	const update = (id: number, patch: Partial<Upload>) =>
		setFiles((all) => all.map((f) => (f.id === id ? { ...f, ...patch } : f)));

	async function upload(file: File, id: number) {
		try {
			const reply = await send(`/upload?ext=${extensionOf(file)}`, {
				method: "POST",
				headers: { "content-type": file.type || "application/octet-stream" },
				body: file,
			});
			if (!reply.ok) throw new Error(`Upload failed (${reply.status})`);
			const { path } = (await reply.json()) as { path: string };
			update(id, { path });
		} catch (failure) {
			update(id, {
				error: failure instanceof Error ? failure.message : "Upload failed",
			});
		}
	}

	function add(list: FileList | File[] | null) {
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

/**
 * +: iOS offers Photo Library, Take Photo or Video, and Choose File.
 * `camera` opens the camera straight away instead.
 */
export function AttachButton({
	uploads,
	camera,
}: {
	uploads: ReturnType<typeof useUploads>;
	camera?: boolean;
}) {
	const input = useRef<HTMLInputElement>(null);
	const Icon = camera ? LuCamera : LuPlus;
	return (
		<>
			<button
				type="button"
				aria-label={camera ? "Take a photo" : "Attach photos or files"}
				onClick={() => input.current?.click()}
				className="flex size-10 shrink-0 items-center justify-center text-foreground"
			>
				<Icon className={camera ? "size-6" : "size-7"} />
			</button>
			<input
				ref={input}
				type="file"
				{...(camera
					? { accept: "image/*", capture: "environment" as const }
					: { multiple: true })}
				className="hidden"
				onChange={(event) => {
					uploads.add(event.target.files);
					event.target.value = "";
				}}
			/>
		</>
	);
}

/** The mic: tap to talk, tap again - the words land in the box. */
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
			disabled={speech.transcribing}
			onClick={() => void speech.toggle()}
			className={`relative flex size-10 shrink-0 items-center justify-center rounded-full ${
				speech.listening
					? "bg-danger text-white"
					: "bg-primary text-primary-foreground"
			}`}
		>
			{speech.listening && (
				<span className="absolute inset-0 animate-ping rounded-full border-2 border-danger/60" />
			)}
			{speech.transcribing ? (
				<LuLoaderCircle className="size-5 animate-spin" />
			) : speech.listening ? (
				<LuSquare className="size-4 fill-current" />
			) : (
				<LuMic className="size-5" />
			)}
		</button>
	);
}

/** The round button once there's something to send. */
export function SendButton({ disabled }: { disabled: boolean }) {
	return (
		<button
			type="submit"
			aria-label="Send"
			disabled={disabled}
			className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-40"
		>
			<LuArrowUp className="size-5" />
		</button>
	);
}

/**
 * Over the text box while you dictate: moving level bars and "Listening",
 * then "Transcribing" until the words land.
 */
export function SpeechStatus({
	speech,
}: {
	speech: ReturnType<typeof useSpeech>;
}) {
	if (!speech.listening && !speech.transcribing) return null;
	return (
		<div className="mx-2.5 mt-2 flex items-center gap-2.5 rounded-xl border border-border bg-card px-3 py-2 text-sm">
			{speech.transcribing ? (
				<>
					<LuLoaderCircle className="size-4 animate-spin text-primary" />
					<span className="text-soft-foreground">Transcribing…</span>
				</>
			) : (
				<>
					<span className="flex h-5 items-center gap-[3px]" aria-hidden>
						{[0, 1, 2, 3, 4].map((bar) => (
							<span
								key={bar}
								className="speech-bar w-[3px] rounded-full bg-danger"
								style={{ animationDelay: `${bar * 0.12}s` }}
							/>
						))}
					</span>
					<span className="text-soft-foreground">
						Listening… tap the mic to stop
					</span>
				</>
			)}
		</div>
	);
}

/** Appends dictated words to what's already typed. */
export const appendWords = (text: string, words: string) =>
	text.trim() ? `${text.trimEnd()} ${words}` : words;
