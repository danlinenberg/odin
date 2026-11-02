import { getHostId } from "@odin/shared/host-info";
import { readOdinConfig } from "../../../lib/trpc/routers/odin-config";
import { sh } from "./session";

/**
 * Who a Linux user on a shared host belongs to. Two Odin users can land on
 * the same one (linuxUserName): two Macs both named "dan" with no GitHub
 * login, or two GitHub logins that share their first 27 characters. They
 * would then share a home, tmux and the phone server there, so each one's
 * phone would see the other's sessions. The first Odin to set the user up
 * writes its ids to ~/.odin/owners; an Odin with none of them is refused.
 */

/** This Odin's ids: its GitHub login (the same on a new Mac), and this computer. */
export function hostOwners(): string[] {
	const login = readOdinConfig().githubLogin?.trim().toLowerCase();
	return [...(login ? [`github:${login}`] : []), `machine:${getHostId()}`];
}

/** Exit code of ownerCheckScript when the user belongs to someone else. */
export const NOT_OWNER_EXIT = 4;

/**
 * Run as the host user: claims the user for `owners` when no one has, adds
 * ids it lacks when one of them is there already (a GitHub login added
 * later, a new Mac), and exits NOT_OWNER_EXIT when none of them is.
 */
export function ownerCheckScript(owners: string[]): string {
	if (!owners.length) throw new Error("No owner ids for the host user.");
	const ids = owners.map(sh).join(" ");
	return [
		'o="$HOME/.odin/owners"',
		'mkdir -p "$HOME/.odin"',
		`if [ -s "$o" ] && ! grep -qxF ${owners.map((id) => `-e ${sh(id)}`).join(" ")} "$o"; then`,
		`  echo "The Linux user $(id -un) on this host belongs to another Odin user. Odin will not share it: ask an administrator to remove that user from the host." >&2`,
		`  exit ${NOT_OWNER_EXIT}`,
		"fi",
		`for i in ${ids}; do grep -qxF -- "$i" "$o" 2>/dev/null || printf '%s\\n' "$i" >> "$o"; done`,
		'chmod 600 "$o"',
	].join("\n");
}
