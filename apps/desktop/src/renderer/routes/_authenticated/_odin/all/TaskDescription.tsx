import { toast } from "@odin/ui/sonner";
import { useEffect, useRef } from "react";
import {
	type MarkdownEditorAdapter,
	TipTapMarkdownRenderer,
} from "renderer/components/MarkdownRenderer";
import { parseDataUrl } from "renderer/hooks/useLaunchTaskSession";
import { electronTrpcClient } from "renderer/lib/trpc-client";
import { readFile } from "../components/OdinPromptDialog";
import { ATTACHMENT_URL } from "../hooks/useOdinTasks";

const isImage = (file: File) => file.type.startsWith("image/");

/**
 * One of my own tasks' brief, edited in place: markdown with headings, lists
 * and images, saved when you click away. A pasted or dropped image is written
 * to ~/.odin/attachments and linked by name - a task is one string in
 * localStorage, so it holds the link, never the bytes.
 */
export function TaskDescription({
	notes,
	onSave,
}: {
	notes: string;
	onSave: (notes: string) => void;
}) {
	const editorRef = useRef<MarkdownEditorAdapter | null>(null);
	const draft = useRef(notes);
	const save = () => {
		if (draft.current.trim() !== notes.trim()) onSave(draft.current.trim());
	};
	// Closing the panel or picking another row unmounts before any blur.
	const saveRef = useRef(save);
	saveRef.current = save;
	useEffect(() => () => saveRef.current(), []);

	const insert = (files: File[], event: React.SyntheticEvent) => {
		const images = files.filter(isImage);
		if (images.length === 0) return;
		// Capture phase, so ProseMirror never sees the bytes.
		event.preventDefault();
		event.stopPropagation();
		void Promise.all(
			images.map(async (file) => {
				const { dataUrl = "" } = await readFile(file);
				const path = await electronTrpcClient.system.saveAttachment.mutate(
					parseDataUrl(dataUrl),
				);
				editorRef.current?.insertImage(
					ATTACHMENT_URL + (path.split("/").at(-1) ?? ""),
				);
			}),
		).catch((error: unknown) =>
			toast.error(`Couldn't add the image: ${error}`),
		);
	};

	return (
		<section
			aria-label="Description"
			className="-mx-1 min-h-[80px] rounded-[5px] px-1 text-[12px] hover:bg-secondary/50 focus-within:bg-secondary/50 focus-within:ring-1 focus-within:ring-primary/50"
			onBlur={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget)) save();
			}}
			onPasteCapture={(event) => insert([...event.clipboardData.files], event)}
			onDropCapture={(event) => insert([...event.dataTransfer.files], event)}
		>
			<TipTapMarkdownRenderer
				value={notes}
				editable
				editorRef={editorRef}
				onChange={(value) => {
					draft.current = value;
				}}
				onSave={save}
				className="h-auto overflow-visible"
			/>
		</section>
	);
}
