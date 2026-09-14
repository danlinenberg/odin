import { createFileRoute } from "@tanstack/react-router";
import { AgentsSettings } from "../components/AgentsSettings";

export const Route = createFileRoute(
	"/_authenticated/settings/agents/$agentId/",
)({
	component: AgentSettingsRoute,
});

function AgentSettingsRoute() {
	const { agentId } = Route.useParams();
	return <AgentsSettings initialAgentId={agentId} />;
}
