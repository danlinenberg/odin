import { useEffect, useState } from "react";
import { LuImage, LuPlus, LuX } from "react-icons/lu";

/**
 * Screenshots shared to Odin from the iOS share sheet: the share extension
 * leaves them for the app (OdinShareExtension, OdinShare.swift), the app
 * takes them when it comes to the front, asks which session they're for, and
 * that screen attaches them to its reply box.
 */

type Native = {
	nativePromise?: (
		plugin: string,
		method: string,
	) => Promise<{ images?: string[] }>;
	Plugins?: {
		App?: {
			addListener: (
				event: "appStateChange",
				listener: (state: { isActive: boolean }) => void,
			) => unknown;
		};
	};
};
const capacitor = (window as { Capacitor?: Native }).Capacitor;

async function takeShared(): Promise<File[]> {
	if (!capacitor?.nativePromise) return [];
	const answer = await capacitor
		.nativePromise("OdinShare", "take")
		.catch(() => undefined);
	const images: string[] = answer?.images ?? [];
	return images.map((base64, index) => {
		const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
		return new File([bytes], `screenshot-${Date.now()}-${index + 1}.jpg`, {
			type: "image/jpeg",
		});
	});
}

/** Files on their way to the screen you picked; it takes them once. */
let waiting: File[] = [];
export const takeSharedFiles = (): File[] => {
	const files = waiting;
	waiting = [];
	return files;
};

/** The new-task sheet opens on this (Home listens). */
export const NEW_TASK_EVENT = "odin:new-task";
const SHARED_EVENT = "odin:shared-files";

/** A screen with a reply box takes shared files when it opens, or when they arrive. */
export function useSharedFiles(add: (files: File[]) => void) {
	// biome-ignore lint/correctness/useExhaustiveDependencies: add is the screen's own, fixed for its life
	useEffect(() => {
		const pick = () => {
			const files = takeSharedFiles();
			if (files.length) add(files);
		};
		pick();
		addEventListener(SHARED_EVENT, pick);
		return () => removeEventListener(SHARED_EVENT, pick);
	}, []);
}

export function SharePicker({
	sessions,
}: {
	sessions: { paneId: string; title: string }[];
}) {
	const [files, setFiles] = useState<File[]>([]);
	useEffect(() => {
		const check = () =>
			void takeShared().then((got) => got.length && setFiles(got));
		check();
		capacitor?.Plugins?.App?.addListener("appStateChange", ({ isActive }) => {
			if (isActive) check();
		});
	}, []);
	if (!files.length) return null;
	const send = (go: () => void) => {
		waiting = files;
		setFiles([]);
		go();
		setTimeout(() => dispatchEvent(new Event(SHARED_EVENT)), 100);
	};
	const count = files.length;
	return (
		<div className="fixed inset-0 z-50 flex items-end bg-black/60">
			<div className="max-h-[75dvh] w-full overflow-y-auto rounded-t-2xl border-t border-border bg-background px-4 pt-4 pb-[calc(env(safe-area-inset-bottom)+16px)]">
				<div className="mb-3 flex items-center gap-2">
					<LuImage className="size-5 text-primary" />
					<h2 className="flex-1 text-lg font-semibold">
						Attach {count === 1 ? "the screenshot" : `${count} screenshots`} to
					</h2>
					<button
						type="button"
						aria-label="Cancel"
						onClick={() => setFiles([])}
						className="p-1 text-muted-foreground"
					>
						<LuX className="size-5" />
					</button>
				</div>
				<button
					type="button"
					onClick={() =>
						send(() => {
							location.hash = "";
							setTimeout(() => dispatchEvent(new Event(NEW_TASK_EVENT)), 50);
						})
					}
					className="mb-2 flex w-full items-center gap-2 rounded-[10px] bg-secondary px-3 py-3 text-left font-medium text-primary"
				>
					<LuPlus className="size-4" />
					New task
				</button>
				{sessions.map((session) => (
					<button
						type="button"
						key={session.paneId}
						onClick={() =>
							send(() => {
								location.hash = `#/s/${session.paneId}`;
							})
						}
						className="mb-2 block w-full truncate rounded-[10px] border border-border bg-card px-3 py-3 text-left text-[15px]"
					>
						{session.title}
					</button>
				))}
			</div>
		</div>
	);
}
