import { Plugin } from "@opencode/plugin";
import { SkillStorage } from "./storage.js";
import type { GitHubRepoInfo, SkillDownloaderOptions } from "./types.js";
/**
 * Sync skills from a GitHub repo to local storage and register them.
 */
export declare function syncSkills(ctx: Plugin.Context, repoInfo: GitHubRepoInfo, storage: SkillStorage, options: SkillDownloaderOptions): Promise<{
    downloaded: number;
    updated: number;
    errors: string[];
}>;
