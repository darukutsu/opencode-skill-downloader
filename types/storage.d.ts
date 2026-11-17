import type { Plugin } from "@opencode/plugin";
import type { SkillState } from "./types.js";
/**
 * Durable state management for skill-sync state, scoped per repo.
 */
export declare class SkillStorage {
    private ctx;
    private repoSlug;
    constructor(ctx: Plugin.Context, repoSlug: string);
    getState(): Promise<SkillState | null>;
    setState(state: SkillState): Promise<void>;
    removeState(): Promise<void>;
}
