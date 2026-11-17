import type { Plugin } from "@opencode/plugin";
import type { SkillEntry, SkillState } from "./types.js";

/**
 * Durable state management for skill-sync state, scoped per repo.
 */
export class SkillStorage {
  constructor(
    private ctx: Plugin.Context,
    private repoSlug: string,
  ) {}

  async getState(): Promise<SkillState | null> {
    const key = `skill-downloader/${this.repoSlug}`;
    const raw = await (this.ctx.storage as any).get(key);
    if (!raw) return null;

    const obj = raw as { repoUrl?: string; lastFetchedAt?: string; lastReleaseTag?: string; skills?: [string, SkillEntry][] };
    const skillsMap = new Map<string, SkillEntry>(obj.skills || []);

    return {
      repoUrl: obj.repoUrl ?? "",
      lastFetchedAt: obj.lastFetchedAt,
      lastReleaseTag: obj.lastReleaseTag,
      skills: skillsMap,
    };
  }

  async setState(state: SkillState): Promise<void> {
    const key = `skill-downloader/${this.repoSlug}`;
    // Convert Map to array for JSON storage
    const skillsArray = Array.from(state.skills.entries()) as [string, SkillEntry][];
    const payload: Record<string, unknown> = {
      repoUrl: state.repoUrl,
      lastFetchedAt: state.lastFetchedAt,
      lastReleaseTag: state.lastReleaseTag,
      skills: skillsArray,
    };
    await (this.ctx.storage as any).set(key, payload);
  }

  async removeState(): Promise<void> {
    const key = `skill-downloader/${this.repoSlug}`;
    await (this.ctx.storage as any).remove(key);
  }
}
