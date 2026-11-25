export { type CellDimensions, getCellDimensions } from "./cell-dimensions";
export {
	buildArrowSequence,
	buildSgrWheelReport,
	consumeWheelLines,
	createScrollRepaint,
	createSgrMouseModeTracker,
	createTerminalWheelEventHandler,
	createWheelLineState,
	installTerminalWheelEventHandler,
	type WheelLineContext,
	type WheelLineInput,
	type WheelLineState,
} from "./terminal-wheel-handler";
