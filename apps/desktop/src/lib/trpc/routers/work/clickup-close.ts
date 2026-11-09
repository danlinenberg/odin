/**
 * Done in Odin closes the task in ClickUp too. One way only: Odin never
 * reopens a ClickUp task, and nothing in ClickUp changes Odin's Done.
 */

/** One status of a ClickUp list, as GET list/{id} returns it. */
export interface ClickupStatus {
	status: string;
	/** "open", "custom", "done" or "closed". */
	type?: string;
	orderindex?: number;
}

/**
 * The list's closing status: the one of type "closed", else one of type
 * "done". Never a name: every list words its statuses its own way.
 */
export function closingStatus(statuses: ClickupStatus[]): string | null {
	const of = (type: string) =>
		statuses.find((status) => status.type?.toLowerCase() === type)?.status;
	return of("closed") ?? of("done") ?? null;
}

/** A ClickUp v2 call: path, token and an optional method and JSON body. */
export type ClickupCall = (
	path: string,
	token: string,
	init?: { method: string; body: string },
) => Promise<Response>;

/**
 * Move task `id` to its list's closing status. Reads the task for its list,
 * the list for its statuses, then sets the status. A task already there is
 * left alone. Throws with what ClickUp said when a step fails.
 */
export async function closeClickupTask(
	id: string,
	token: string,
	call: ClickupCall,
): Promise<{ status: string }> {
	const get = async <T>(path: string): Promise<T> => {
		const response = await call(path, token);
		if (!response.ok)
			throw new Error(`ClickUp answered HTTP ${response.status}`);
		return (await response.json()) as T;
	};
	const task = await get<{
		status?: { status?: string };
		list?: { id?: string };
	}>(`task/${encodeURIComponent(id)}`);
	const listId = task.list?.id;
	if (!listId) throw new Error("ClickUp didn't say which list the task is in");
	const { statuses = [] } = await get<{ statuses?: ClickupStatus[] }>(
		`list/${encodeURIComponent(listId)}`,
	);
	const status = closingStatus(statuses);
	if (!status) throw new Error("the task's list has no closed or done status");
	if (task.status?.status?.toLowerCase() === status.toLowerCase())
		return { status };
	const response = await call(`task/${encodeURIComponent(id)}`, token, {
		method: "PUT",
		body: JSON.stringify({ status }),
	});
	if (!response.ok)
		throw new Error(
			response.status === 401 || response.status === 403
				? "ClickUp refused the change - the token can't edit this task"
				: `ClickUp answered HTTP ${response.status}`,
		);
	return { status };
}
