import { TaskReadError } from "./types";

/** The command was rejected before delivery; a fresh explicit action may be tried. */
export class SourceActionRejectedError extends TaskReadError {}
