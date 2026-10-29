/**
 * Release tags read off github.com pages rather than api.github.com. The API
 * allows 60 unauthenticated calls an hour per IP, and an office's Odins share
 * one IP - past that every check came back 403. These pages have no such cap.
 */

/** The tag in `/releases/latest`'s redirect: `.../releases/tag/v1.0.22`. */
export function tagFromLocation(location: string | null): string | null {
	return location?.match(/\/releases\/tag\/([^/?#]+)$/)?.[1] ?? null;
}

/** The newest release's tag, the first entry of `/releases.atom` (drafts aren't in it). */
export function newestTagFromFeed(feed: string): string | null {
	return feed.match(/\/releases\/tag\/([^"/<]+)"/)?.[1] ?? null;
}
