import { Toaster } from "@odin/ui/sonner";
import { useTheme } from "renderer/stores/theme/store";

export function ThemedToaster() {
	const theme = useTheme();
	// Bottom-center: row actions (✓ Done) sit on the right edge, so a toast there
	// covers the next row's Done and blocks clicking several in a row.
	return (
		<Toaster expand position="bottom-center" theme={theme?.type ?? "dark"} />
	);
}
