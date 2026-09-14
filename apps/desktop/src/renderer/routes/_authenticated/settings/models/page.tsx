import { ChatServiceProvider } from "@odin/chat-legacy/client";
import { createFileRoute } from "@tanstack/react-router";
import { createChatServiceIpcClient } from "renderer/components/Chat/utils/chat-service-client";
import { electronQueryClient } from "renderer/providers/ElectronTRPCProvider";
import { ModelsSettings } from "./components/ModelsSettings";

export const Route = createFileRoute("/_authenticated/settings/models/")({
	component: ModelsSettingsPage,
});

const chatServiceIpcClient = createChatServiceIpcClient();

function ModelsSettingsPage() {
	return (
		<ChatServiceProvider
			client={chatServiceIpcClient}
			queryClient={electronQueryClient}
		>
			<ModelsSettings />
		</ChatServiceProvider>
	);
}
