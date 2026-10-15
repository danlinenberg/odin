import { Button } from "@odin/ui/button";
import { Input } from "@odin/ui/input";
import { toast } from "@odin/ui/sonner";
import { cn } from "@odin/ui/utils";
import { useState } from "react";
import { LuTrash2 } from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	SettingRow,
	SettingsSection,
	StatusDot,
} from "../../components/SettingsPage";

type AuthMethod = "key" | "password";

interface ConnectionForm {
	name: string;
	host: string;
	sshPort: string;
	username: string;
	authMethod: AuthMethod;
	sshKeyPath: string;
	password: string;
	odinFolder: string;
	remoteHostServicePort: string;
}

const EMPTY_FORM: ConnectionForm = {
	name: "",
	host: "",
	sshPort: "22",
	username: "",
	authMethod: "key",
	sshKeyPath: "",
	password: "",
	odinFolder: "~/.odin",
	remoteHostServicePort: "48000",
};

/**
 * Settings > Advanced > Remote server: the machines Odin can run its backend
 * on, and the form that adds one.
 */
export function RemoteServerSection() {
	const utils = electronTrpc.useUtils();
	const { data: connections = [] } =
		electronTrpc.remoteConnections.list.useQuery();
	const { data: active } = electronTrpc.remoteConnections.getActive.useQuery(
		undefined,
		{ refetchInterval: 5_000 },
	);

	electronTrpc.remoteConnections.onStatusChange.useSubscription(undefined, {
		onData: () => utils.remoteConnections.getActive.invalidate(),
	});

	const [form, setForm] = useState<ConnectionForm>(EMPTY_FORM);

	const refresh = () => {
		utils.remoteConnections.list.invalidate();
		utils.remoteConnections.getActive.invalidate();
	};

	const create = electronTrpc.remoteConnections.create.useMutation({
		onSuccess: () => {
			setForm(EMPTY_FORM);
			refresh();
			toast.success("Remote connection saved.");
		},
		onError: (error) => toast.error(error.message),
	});
	const remove = electronTrpc.remoteConnections.delete.useMutation({
		onSuccess: refresh,
		onError: (error) => toast.error(error.message),
	});
	const connect = electronTrpc.remoteConnections.connect.useMutation({
		onSuccess: () => {
			refresh();
			toast.success("Connected to the remote backend.");
		},
		onError: (error) => toast.error(`Connect failed: ${error.message}`),
	});
	const disconnect = electronTrpc.remoteConnections.disconnect.useMutation({
		onSuccess: refresh,
		onError: (error) => toast.error(error.message),
	});
	const test = electronTrpc.remoteConnections.testConnection.useMutation();

	const canSave = Boolean(
		form.name.trim() &&
			form.host.trim() &&
			form.username.trim() &&
			form.odinFolder.trim() &&
			(form.authMethod === "key" || form.password),
	);

	const save = () => {
		create.mutate({
			name: form.name.trim(),
			host: form.host.trim(),
			sshPort: Number(form.sshPort) || 22,
			username: form.username.trim(),
			authMethod: form.authMethod,
			sshKeyPath:
				form.authMethod === "key" ? form.sshKeyPath.trim() || null : null,
			password: form.authMethod === "password" ? form.password : null,
			odinFolder: form.odinFolder.trim(),
			remoteHostServicePort: Number(form.remoteHostServicePort) || 48000,
		});
	};

	const field = (key: keyof ConnectionForm) => ({
		value: form[key],
		onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
			setForm((prev) => ({ ...prev, [key]: event.target.value })),
	});

	return (
		<>
			<SettingsSection
				title="Remote server"
				description="Run Odin's workspace backend (workspaces, their terminals, agent and git settings) on any Linux server you can SSH into. Dev Board sessions still run on this Mac for now. The server needs nothing installed: Odin brings its own Node and sets it up in the odin folder on the first connect, which needs internet on the server once. Only the path to your SSH key is stored - never the key itself."
			>
				{connections.length === 0 ? (
					<SettingRow
						label="No connections yet"
						description="Add one below, then connect from here or the home top bar."
					/>
				) : (
					connections.map((connection) => {
						const isActive =
							active?.connectionId === connection.id &&
							active.status === "connected";
						const isConnecting =
							active?.connectionId === connection.id &&
							active.status === "connecting";
						return (
							<SettingRow
								key={connection.id}
								label={connection.name}
								description={`${connection.username}@${connection.host}:${connection.sshPort} - ${connection.odinFolder}`}
							>
								<StatusDot
									loading={isConnecting}
									configured={isActive}
									identity={isActive ? "Connected" : null}
									error={null}
								/>
								<Button
									variant="outline"
									size="sm"
									disabled={test.isPending}
									onClick={async () => {
										const result = await test.mutateAsync({
											id: connection.id,
										});
										if (result.ok) toast.success(result.message);
										else toast.error(result.message);
									}}
								>
									Test
								</Button>
								{isActive ? (
									<Button
										variant="outline"
										size="sm"
										disabled={disconnect.isPending}
										onClick={() => disconnect.mutate()}
									>
										Disconnect
									</Button>
								) : (
									<Button
										variant="outline"
										size="sm"
										disabled={connect.isPending}
										onClick={() => connect.mutate({ id: connection.id })}
									>
										Connect
									</Button>
								)}
								<Button
									variant="ghost"
									size="icon"
									aria-label="Delete connection"
									disabled={remove.isPending}
									onClick={() => remove.mutate({ id: connection.id })}
								>
									<LuTrash2 className="size-4" />
								</Button>
							</SettingRow>
						);
					})
				)}
			</SettingsSection>

			<SettingsSection
				title="Add a connection"
				description="Any Linux server on x86_64 or arm64, with an SSH key or a password. Point the odin folder at a writable path there - it holds Odin's Node, the backend's logs, database and worktrees. Test connection checks all of this before you connect."
			>
				<SettingRow label="Name" htmlFor="remote-name">
					<Input
						id="remote-name"
						className="w-64"
						placeholder="Build box"
						{...field("name")}
					/>
				</SettingRow>
				<SettingRow label="Server address" htmlFor="remote-host">
					<Input
						id="remote-host"
						className="w-64"
						placeholder="10.0.0.42 or build.example.com"
						{...field("host")}
					/>
				</SettingRow>
				<SettingRow label="SSH username" htmlFor="remote-username">
					<Input
						id="remote-username"
						className="w-64"
						placeholder="ubuntu"
						{...field("username")}
					/>
				</SettingRow>
				<SettingRow label="SSH port" htmlFor="remote-ssh-port">
					<Input
						id="remote-ssh-port"
						type="number"
						className="w-28 tabular-nums"
						{...field("sshPort")}
					/>
				</SettingRow>
				<SettingRow
					label="Authentication"
					description="Log in with an SSH key or a username and password."
				>
					<div className="flex items-center gap-1 rounded-md bg-secondary p-0.5">
						{(["key", "password"] as const).map((method) => (
							<button
								key={method}
								type="button"
								onClick={() =>
									setForm((prev) => ({ ...prev, authMethod: method }))
								}
								className={cn(
									"rounded px-2.5 py-1 text-xs font-medium capitalize transition-colors",
									form.authMethod === method
										? "bg-background text-foreground shadow-sm"
										: "text-muted-foreground hover:text-foreground",
								)}
							>
								{method === "key" ? "SSH key" : "Password"}
							</button>
						))}
					</div>
				</SettingRow>
				{form.authMethod === "key" ? (
					<SettingRow
						label="SSH key path"
						htmlFor="remote-key"
						description="Leave blank to use your SSH agent or default identity."
					>
						<Input
							id="remote-key"
							className="w-64"
							placeholder="~/.ssh/id_ed25519"
							{...field("sshKeyPath")}
						/>
					</SettingRow>
				) : (
					<SettingRow
						label="Password"
						htmlFor="remote-password"
						description="Stored encrypted on this machine with the OS keychain, never in plain text."
					>
						<Input
							id="remote-password"
							type="password"
							className="w-64"
							autoComplete="off"
							{...field("password")}
						/>
					</SettingRow>
				)}
				<SettingRow label="Odin folder" htmlFor="remote-folder">
					<Input
						id="remote-folder"
						className="w-64"
						placeholder="~/.odin"
						{...field("odinFolder")}
					/>
				</SettingRow>
				<SettingRow
					label="Host-service port"
					htmlFor="remote-service-port"
					description="Port the backend listens on remotely, forwarded over the SSH tunnel."
				>
					<Input
						id="remote-service-port"
						type="number"
						className="w-28 tabular-nums"
						{...field("remoteHostServicePort")}
					/>
				</SettingRow>
				<SettingRow label="Save connection">
					<Button
						size="sm"
						disabled={!canSave || create.isPending}
						onClick={save}
					>
						Save
					</Button>
				</SettingRow>
			</SettingsSection>
		</>
	);
}
