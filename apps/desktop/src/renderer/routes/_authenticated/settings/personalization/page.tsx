import { Button } from "@odin/ui/button";
import { Input } from "@odin/ui/input";
import { toast } from "@odin/ui/sonner";
import { Switch } from "@odin/ui/switch";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { HiMiniPlus, HiMiniXMark } from "react-icons/hi2";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	SettingRow,
	SettingsPage,
	SettingsSection,
} from "../components/SettingsPage";

export const Route = createFileRoute(
	"/_authenticated/settings/personalization/",
)({
	component: PersonalizationSettingsPage,
});

/**
 * Settings > Personalization: Odin fitted to you - for now, drafts a session
 * writes for you to send, in your own voice.
 */
function PersonalizationSettingsPage() {
	return (
		<SettingsPage
			title="Personalization"
			description="How Odin fits itself to you."
		>
			<SettingsSection
				title="Your voice"
				description="Drafts a session writes for you to send - Slack replies, Jira and GitHub comments - follow a guide Odin learns from your own Slack messages. It retrains once a day on its own."
			>
				<VoiceRows />
			</SettingsSection>
		</SettingsPage>
	);
}

/** "3 hours ago" for a stored ISO time; "never" when there is none. */
function ago(iso: string | null): string {
	if (!iso) return "never";
	const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

/**
 * The voice guide (main/lib/voice-profile.ts): on/off, Train now, what it
 * learned, and the corrections sessions recorded. Polls while training runs.
 */
function VoiceRows() {
	const utils = electronTrpc.useUtils();
	const { data: voice } = electronTrpc.voice.get.useQuery(undefined, {
		refetchInterval: (query) => (query.state.data?.training ? 2000 : false),
	});
	const refresh = () => void utils.voice.get.invalidate();
	const onError = (error: { message: string }) => toast.error(error.message);
	const setEnabled = electronTrpc.voice.setEnabled.useMutation({
		onSuccess: refresh,
		onError,
	});
	const train = electronTrpc.voice.train.useMutation({
		onSuccess: refresh,
		onError,
	});
	const setNotes = electronTrpc.voice.setNotes.useMutation({
		onSuccess: refresh,
		onError,
	});
	const enabled = voice?.enabled ?? true;
	const training = voice?.training || train.isPending;

	return (
		<>
			<SettingRow
				label="Write drafts in my voice"
				htmlFor="voice-enabled"
				description="Off: Odin stops learning from your messages and sessions write drafts in their own plain style."
			>
				<Switch
					id="voice-enabled"
					checked={enabled}
					disabled={!voice || setEnabled.isPending}
					onCheckedChange={(next) => setEnabled.mutate({ enabled: next })}
				/>
			</SettingRow>
			<SettingRow
				label="Train now"
				description={`Reads your recent sent Slack messages and rewrites the guide. Learned from ${voice?.samples ?? 0} messages; trained ${ago(voice?.trainedAt ?? null)}, guide updated ${ago(voice?.updatedAt ?? null)}.`}
			>
				<Button
					variant="outline"
					size="sm"
					className="h-8"
					disabled={!enabled || training}
					onClick={() => train.mutate()}
				>
					{training ? "Training…" : "Train now"}
				</Button>
			</SettingRow>
			{voice?.error && !training && (
				<p className="select-text cursor-text text-xs text-destructive">
					{voice.error}
				</p>
			)}
			<SettingRow
				label="What Odin learned"
				description="The guide a session reads before it drafts a message for you."
				stacked
			>
				<div className="max-h-96 select-text cursor-text overflow-auto rounded-md bg-muted px-4 py-3 text-xs leading-relaxed">
					{voice?.guide ? (
						<ReactMarkdown
							remarkPlugins={[remarkGfm]}
							components={{
								ul: ({ children }) => (
									<ul className="flex list-disc flex-col gap-2 pl-4">
										{children}
									</ul>
								),
								ol: ({ children }) => (
									<ol className="flex list-decimal flex-col gap-2 pl-4">
										{children}
									</ol>
								),
								p: ({ children }) => <p className="my-2">{children}</p>,
								strong: ({ children }) => (
									<strong className="font-semibold text-foreground">
										{children}
									</strong>
								),
								code: ({ children }) => (
									<code className="rounded bg-background/60 px-1 font-mono">
										{children}
									</code>
								),
							}}
						>
							{voice.guide}
						</ReactMarkdown>
					) : (
						"Nothing yet - press Train now."
					)}
				</div>
			</SettingRow>
			<SettingRow
				label="Corrections"
				description="Sessions add one when you correct how a draft sounds; they always win over what Odin learned."
				stacked
			>
				<CorrectionRows
					notes={voice?.notes ?? []}
					onChange={(notes) => setNotes.mutate({ notes })}
				/>
			</SettingRow>
		</>
	);
}

/**
 * The voice corrections, one row each: edit in place (saved on blur), remove
 * with the X, add a new one at the bottom.
 */
function CorrectionRows({
	notes,
	onChange,
}: {
	notes: string[];
	onChange: (notes: string[]) => void;
}) {
	const [drafts, setDrafts] = useState<Record<number, string>>({});
	const [adding, setAdding] = useState("");

	const save = (index: number) => {
		const draft = drafts[index];
		setDrafts(({ [index]: _, ...rest }) => rest);
		if (draft === undefined || draft === notes[index]) return;
		onChange(notes.map((note, i) => (i === index ? draft : note)));
	};
	const add = () => {
		if (!adding.trim()) return;
		onChange([...notes, adding]);
		setAdding("");
	};

	return (
		<div className="flex flex-col gap-1.5">
			{notes.length === 0 && (
				<p className="text-xs text-muted-foreground">No corrections yet.</p>
			)}
			{notes.map((note, index) => (
				<div key={note} className="group/note flex items-center gap-2">
					<Input
						value={drafts[index] ?? note}
						aria-label={`Correction ${index + 1}`}
						className="h-8 min-w-0 flex-1 text-xs"
						onChange={(event) =>
							setDrafts((now) => ({ ...now, [index]: event.target.value }))
						}
						onBlur={() => save(index)}
						onKeyDown={(event) => {
							if (event.key === "Enter") event.currentTarget.blur();
						}}
					/>
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						aria-label={`Remove correction ${index + 1}`}
						className="h-8 w-8 shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
						onClick={() => onChange(notes.filter((_, i) => i !== index))}
					>
						<HiMiniXMark className="h-3.5 w-3.5" />
					</Button>
				</div>
			))}
			<div className="flex items-center gap-2">
				<Input
					value={adding}
					placeholder="Add a correction, e.g. no sign-off"
					aria-label="New correction"
					className="h-8 min-w-0 flex-1 text-xs"
					onChange={(event) => setAdding(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") add();
					}}
				/>
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					aria-label="Add correction"
					className="h-8 w-8 shrink-0 text-muted-foreground"
					disabled={!adding.trim()}
					onClick={add}
				>
					<HiMiniPlus className="h-3.5 w-3.5" />
				</Button>
			</div>
		</div>
	);
}
