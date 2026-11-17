import { join as pathJoin } from "path";
/**
 * Derive paths from the opencode config directory (~/.config/opencode).
 */
export declare function getConfigDir(): string;
export declare function getSkillsDir(): string;
export declare function getLogDir(): string;
export declare function getLogPath(): string;
export declare const join: typeof pathJoin;
