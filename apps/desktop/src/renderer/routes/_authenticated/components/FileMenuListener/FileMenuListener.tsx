import { toast } from "@odin/ui/sonner";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useOpenProject } from "renderer/react-query/projects";

export function FileMenuListener() {
	const { openNew } = useOpenProject();

	electronTrpc.menu.subscribe.useSubscription(undefined, {
		onData: async (event) => {
			if (event.type !== "open-project") return;
			const projects = await openNew();
			if (projects.length > 0) {
				toast.success("Project ready — open it from the sidebar.");
			}
		},
	});

	return null;
}
