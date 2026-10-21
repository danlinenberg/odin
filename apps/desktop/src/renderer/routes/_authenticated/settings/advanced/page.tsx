import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/settings/advanced/")({
	component: AdvancedRedirect,
});

/**
 * There is no Advanced screen any more: the Claude command and the default
 * prompt are on Sessions, and the worktree pruner's switch is on Storage. An
 * old link still lands somewhere.
 */
function AdvancedRedirect() {
	return <Navigate to="/settings/sessions" replace />;
}
