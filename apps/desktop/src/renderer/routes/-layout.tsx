import { Alerter } from "@odin/ui/atoms/Alert";
import { type ReactNode, useEffect } from "react";
import { ThemedToaster } from "renderer/components/ThemedToaster";
import {
	getBinding,
	type HotkeyId,
	parseBinding,
	useHotkeyOverridesStore,
} from "renderer/hotkeys";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { ElectronTRPCProvider } from "renderer/providers/ElectronTRPCProvider";

export function RootLayout({ children }: { children: ReactNode }) {
	return (
		<ElectronTRPCProvider>
			{children}
			<MenuChords />
			<ThemedToaster />
			<Alerter />
		</ElectronTRPCProvider>
	);
}

/** The native menu's items; main registers their bindings as accelerators. */
const MENU_HOTKEYS: HotkeyId[] = [
	"OPEN_PROJECT",
	"RELOAD_WINDOW",
	"ZOOM_RESET",
	"ZOOM_IN",
	"ZOOM_OUT",
	"CLOSE_WINDOW",
	"SHOW_HOTKEYS",
	"OPEN_SETTINGS",
];

function MenuChords() {
	const overrides = useHotkeyOverridesStore((state) => state.overrides);
	const setMenuChords = electronTrpc.menu.setMenuChords.useMutation();
	// biome-ignore lint/correctness/useExhaustiveDependencies: mutate is stable; overrides is the trigger
	useEffect(() => {
		setMenuChords.mutate(
			Object.fromEntries(
				MENU_HOTKEYS.map((id) => {
					const binding = getBinding(id);
					return [id, binding ? parseBinding(binding).chord : null];
				}),
			),
		);
	}, [overrides]);
	return null;
}
