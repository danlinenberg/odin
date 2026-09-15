import { createFileRoute } from "@tanstack/react-router";
import { NotFound } from "renderer/routes/not-found";
import { ProjectSettings } from "../../project/$projectId/components/ProjectSettings";

export const Route = createFileRoute(
	"/_authenticated/settings/projects/$projectId/",
)({
	component: ProjectDetailPage,
	notFoundComponent: NotFound,
});

function ProjectDetailPage() {
	const { projectId } = Route.useParams();
	return <ProjectSettings projectId={projectId} />;
}
