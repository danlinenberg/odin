import { Navigate } from "@tanstack/react-router";

// Hoisted for stable props identity — <Navigate> re-navigates every re-render
// otherwise (react error #185 loop).
const boardRedirect = <Navigate to="/board" replace />;

/**
 * Odin fork: there is nowhere to 404 to. This app is the Dev Board and a few
 * feeds, so any unknown or stale URL (e.g. a restored
 * #/workspace/<deleted-id> from an older build) goes straight to the board
 * instead of showing a dead-end 404 page.
 */
export function NotFound() {
	return boardRedirect;
}
