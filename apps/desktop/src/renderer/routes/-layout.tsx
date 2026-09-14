import { Alerter } from "@odin/ui/atoms/Alert";
import type { ReactNode } from "react";
import { ThemedToaster } from "renderer/components/ThemedToaster";
import { ElectronTRPCProvider } from "renderer/providers/ElectronTRPCProvider";

export function RootLayout({ children }: { children: ReactNode }) {
	return (
		<ElectronTRPCProvider>
			{children}
			<ThemedToaster />
			<Alerter />
		</ElectronTRPCProvider>
	);
}
