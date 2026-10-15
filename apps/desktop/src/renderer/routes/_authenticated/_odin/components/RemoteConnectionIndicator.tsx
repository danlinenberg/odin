import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@odin/ui/dropdown-menu";
import { toast } from "@odin/ui/sonner";
import { cn } from "@odin/ui/utils";
import { useNavigate } from "@tanstack/react-router";
import { electronTrpc } from "renderer/lib/electron-trpc";

/**
 * Home top-bar control that shows where Odin's backend is running. Lit green
 * with the connection name when a remote backend is connected, a quiet "Local"
 * otherwise. The dropdown connects to any configured remote, disconnects back
 * to local, or opens Settings > Advanced > Remote server.
 */
export function RemoteConnectionIndicator() {
	const navigate = useNavigate();
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

	const connect = electronTrpc.remoteConnections.connect.useMutation({
		onSuccess: () => {
			utils.remoteConnections.getActive.invalidate();
			toast.success("Connected to the remote backend.");
		},
		onError: (error) => toast.error(`Connect failed: ${error.message}`),
	});
	const disconnect = electronTrpc.remoteConnections.disconnect.useMutation({
		onSuccess: () => utils.remoteConnections.getActive.invalidate(),
		onError: (error) => toast.error(error.message),
	});

	const isConnected = active?.status === "connected";
	const isConnecting = active?.status === "connecting";
	const busy = connect.isPending || disconnect.isPending || isConnecting;
	const label = isConnected
		? active.name
		: isConnecting
			? "Connecting…"
			: "Local";
	const dotColor = isConnected
		? "bg-success"
		: isConnecting
			? "bg-attention"
			: "bg-muted-foreground/40";

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					title={
						isConnected
							? `Backend running on ${active.host}`
							: "Backend running locally"
					}
					className={cn(
						"flex items-center gap-1.5 rounded-[6px] px-2 py-[3px] text-[11px] font-semibold transition-colors",
						isConnected
							? "bg-success/15 text-success"
							: "bg-secondary text-muted-foreground hover:text-foreground",
						busy && "opacity-70",
					)}
				>
					<span className={cn("size-2 rounded-full", dotColor)} />
					<span className="max-w-[140px] truncate">{label}</span>
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="z-[70] min-w-[220px]">
				<DropdownMenuLabel>Run the backend on</DropdownMenuLabel>
				<DropdownMenuItem
					disabled={busy || !isConnected}
					onSelect={() => disconnect.mutate()}
				>
					<span
						className={cn(
							"mr-2 size-2 rounded-full",
							isConnected ? "bg-muted-foreground/40" : "bg-success",
						)}
					/>
					This computer (Local)
				</DropdownMenuItem>
				{connections.length > 0 && <DropdownMenuSeparator />}
				{connections.map((connection) => {
					const thisActive =
						active?.connectionId === connection.id && isConnected;
					return (
						<DropdownMenuItem
							key={connection.id}
							disabled={busy || thisActive}
							onSelect={() => connect.mutate({ id: connection.id })}
						>
							<span
								className={cn(
									"mr-2 size-2 rounded-full",
									thisActive ? "bg-success" : "bg-muted-foreground/40",
								)}
							/>
							<span className="truncate">{connection.name}</span>
							<span className="ml-auto pl-3 text-[11px] text-muted-foreground">
								{connection.host}
							</span>
						</DropdownMenuItem>
					);
				})}
				<DropdownMenuSeparator />
				<DropdownMenuItem
					onSelect={() => navigate({ to: "/settings/advanced" })}
				>
					Manage in Settings…
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
