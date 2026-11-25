import {
	DndContext,
	type DragEndEvent,
	DragOverlay,
	type DragStartEvent,
	MouseSensor,
	useDraggable,
	useDroppable,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import { cn } from "@odin/ui/utils";
import { useState } from "react";
import { LuLayoutList, LuSquareKanban } from "react-icons/lu";
import { emojify } from "renderer/lib/emoji";
import { FeedSelect } from "../components/FeedChrome";
import type { AllItem } from "./all-items";
import { SOURCE_ICON } from "./TaskTable";
import {
	type BoardColumn,
	GROUP_BYS,
	type GroupBy,
	type TaskView,
} from "./task-board";

/** List / Board, and on the board the field its columns are cut by. */
export function TaskViewSwitch({
	view,
	groupBy,
	onView,
	onGroupBy,
}: {
	view: TaskView;
	groupBy: GroupBy;
	onView: (view: TaskView) => void;
	onGroupBy: (groupBy: GroupBy) => void;
}) {
	const segment = (active: boolean) =>
		cn(
			"flex items-center gap-1 px-2 py-[3px] text-[12px] font-medium",
			active
				? "bg-primary text-primary-foreground"
				: "text-foreground/80 hover:bg-accent hover:text-foreground",
		);
	return (
		<>
			{view === "board" && (
				<FeedSelect
					value={groupBy}
					onChange={(value) => onGroupBy(value as GroupBy)}
					title="Group by - one column per value of this field"
				>
					{GROUP_BYS.map(({ id, label }) => (
						<option key={id} value={id}>
							Group by {label}
						</option>
					))}
				</FeedSelect>
			)}
			<div className="flex shrink-0 overflow-hidden rounded-full border border-border bg-card">
				<button
					type="button"
					aria-pressed={view === "list"}
					title="List - the bands, Now, Today and Later"
					onClick={() => onView("list")}
					className={segment(view === "list")}
				>
					<LuLayoutList className="size-3.5" aria-hidden />
					List
				</button>
				<button
					type="button"
					aria-pressed={view === "board"}
					title="Board - a column per Type, Status or Priority"
					onClick={() => onView("board")}
					className={segment(view === "board")}
				>
					<LuSquareKanban className="size-3.5" aria-hidden />
					Board
				</button>
			</div>
		</>
	);
}

/**
 * The tasks as a board: a column per value, a card per task. A click opens
 * the side panel, as a row's title does; dragging a card to another column
 * sets that field (`onMove`).
 */
export function TaskBoard({
	columns,
	openKey,
	onOpen,
	onMove,
}: {
	columns: BoardColumn[];
	openKey: string | null;
	onOpen: (key: string) => void;
	onMove: (item: AllItem, columnId: string) => void;
}) {
	const sensors = useSensors(
		useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
	);
	const [dragging, setDragging] = useState<AllItem | null>(null);
	const find = (key: string) =>
		columns.flatMap((column) => column.items).find((item) => item.key === key);
	const onDragStart = ({ active }: DragStartEvent) =>
		setDragging(find(String(active.id)) ?? null);
	const onDragEnd = ({ active, over }: DragEndEvent) => {
		setDragging(null);
		const item = find(String(active.id));
		if (!item || !over) return;
		const target = String(over.id);
		const from = columns.find((column) => column.items.includes(item));
		if (from?.id !== target) onMove(item, target);
	};
	return (
		<DndContext
			sensors={sensors}
			onDragStart={onDragStart}
			onDragEnd={onDragEnd}
			onDragCancel={() => setDragging(null)}
		>
			<div
				data-task-board
				className="flex min-h-0 min-w-0 flex-1 gap-3 overflow-x-auto px-[18px] py-3"
			>
				{columns.map((column) => (
					<Column
						key={column.id}
						column={column}
						openKey={openKey}
						onOpen={onOpen}
					/>
				))}
			</div>
			<DragOverlay dropAnimation={null}>
				{dragging && <Card item={dragging} open={false} />}
			</DragOverlay>
		</DndContext>
	);
}

function Column({
	column,
	openKey,
	onOpen,
}: {
	column: BoardColumn;
	openKey: string | null;
	onOpen: (key: string) => void;
}) {
	const { setNodeRef, isOver } = useDroppable({ id: column.id });
	return (
		<div
			ref={setNodeRef}
			data-board-column={column.label}
			className={cn(
				"flex w-[260px] shrink-0 flex-col rounded-[10px] border bg-card/40",
				isOver ? "border-primary/60 bg-primary/5" : "border-border",
			)}
		>
			<div className="flex items-center gap-2 px-3 pt-2.5 pb-1.5 text-[12px] font-semibold text-foreground">
				{column.label}
				<span className="rounded-[10px] bg-secondary px-1.5 font-medium text-muted-foreground tabular-nums">
					{column.items.length}
				</span>
			</div>
			<div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-2 pb-2">
				{column.items.map((item) => (
					<DraggableCard
						key={item.key}
						item={item}
						open={item.key === openKey}
						onOpen={() => onOpen(item.key)}
					/>
				))}
			</div>
		</div>
	);
}

function DraggableCard({
	item,
	open,
	onOpen,
}: {
	item: AllItem;
	open: boolean;
	onOpen: () => void;
}) {
	const { setNodeRef, attributes, listeners, isDragging } = useDraggable({
		id: item.key,
	});
	return (
		<div
			ref={setNodeRef}
			{...attributes}
			{...listeners}
			className={cn(isDragging && "opacity-40")}
		>
			<Card item={item} open={open} onOpen={onOpen} />
		</div>
	);
}

/** A task on the board: its title, and where it came from. */
function Card({
	item,
	open,
	onOpen,
}: {
	item: AllItem;
	open: boolean;
	onOpen?: () => void;
}) {
	const Icon = SOURCE_ICON[item.to];
	return (
		<button
			type="button"
			data-task-card={item.key}
			onClick={onOpen}
			className={cn(
				"flex w-full flex-col gap-1 rounded-md border bg-card px-2.5 py-2 text-left shadow-sm hover:bg-secondary",
				open ? "border-primary/60" : "border-border",
			)}
		>
			<span className="line-clamp-3 text-[13px] text-foreground">
				{emojify(item.title)}
			</span>
			<span className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
				{Icon && <Icon className="size-3 shrink-0" aria-hidden />}
				<span className="shrink-0">{item.source}</span>
				{item.context && (
					<span className="min-w-0 truncate">· {item.context}</span>
				)}
			</span>
		</button>
	);
}
