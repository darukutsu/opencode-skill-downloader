import { Plugin, Skill } from "@opencode/plugin";
import { parseGitHubUrl, _retryTimers } from "./github.js";
import { SkillStorage } from "./storage.js";
import { syncSkills } from "./sync.js";
import { getConfigDir, getLogPath, join } from "./paths.js";
import type { GitHubRepoInfo, SkillDownloaderOptions } from "./types.js";
import { appendFileSync } from "fs";

// Prevent multiple setup() calls from hot-reload re-triggering sync
let _synced = false;

/**
 * Read skills array from opencode.jsonc config file.
 * Strips JSONC comments before parsing.
 */
async function readSkillsFromConfig(): Promise<string[]> {
  const fs = await import("fs");
  const path = await import("path");

  const configPath = join(getConfigDir(), "opencode.jsonc");

  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    // Strip JSONC comments: lines starting with // (with optional leading whitespace)
    const stripped = raw
      .split("\n")
      .map((line: string) => {
        // Remove inline comments: find // not inside strings
        let inString = false;
        let escape = false;
        let result = "";
        for (let i = 0; i < line.length; i++) {
          const ch = line[i];
          if (inString) {
            if (escape) {
              result += ch;
              escape = false;
            } else if (ch === "\\") {
              escape = true;
              result += ch;
            } else if (ch === '"') {
              inString = false;
              result += ch;
            } else {
              result += ch;
            }
          } else {
            if (ch === '"') {
              inString = true;
              result += ch;
            } else if (ch === "/" && i + 1 < line.length && line[i + 1] === "/") {
              // Comment from here to end of line
              break;
            } else {
              result += ch;
            }
          }
        }
        return result;
      })
      .join("\n");

    const config = JSON.parse(stripped) as Record<string, unknown>;
    const skills = config.skills;
    if (!Array.isArray(skills)) return [];

    return skills.filter((s): s is string => typeof s === "string");
  } catch {
    return [];
  }
}

const SYNC_TIMEOUT_MS = 120000; // 120 seconds max — repos with 100+ dirs need time

/**
 * Perform a full sync for all configured URLs.
 * Times out after 10s to prevent blocking OpenCode's main thread.
 */
async function performFullSync(
  ctx: Plugin.Context,
  urls: string[],
  options: SkillDownloaderOptions,
): Promise<void> {
  appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] performFullSync called with ${urls.length} urls\n`);

  let timedOut = false;
  const timeoutPromise = new Promise<void>((resolve) => {
    setTimeout(() => {
      timedOut = true;
      appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] performFullSync TIMEOUT after ${SYNC_TIMEOUT_MS}ms\n`);
      console.log(`[skill-downloader] Sync timeout after ${SYNC_TIMEOUT_MS}ms, resetting sync flag for retry.`);
      resolve();
    }, SYNC_TIMEOUT_MS);
  });

  try {
    await Promise.race([
      (async () => {
        for (const url of urls) {
          const repoInfo = parseGitHubUrl(url);
          appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] parsing ${url}: ${JSON.stringify(repoInfo)}\n`);
          if (!repoInfo) {
            appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] invalid URL: ${url}\n`);
            console.log(`[skill-downloader] Invalid URL: ${url}, skipping`);
            continue;
          }

          const repoSlug = `${repoInfo.owner}/${repoInfo.repo}`;
          appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] SYNCING repo: ${repoSlug}\n`);
          console.log(`[skill-downloader] Syncing ${repoSlug}...`);

          const storage = new SkillStorage(ctx, repoSlug);

          try {
            await syncSkills(ctx, repoInfo, storage, options);
          } catch (err) {
            console.log(`[skill-downloader] Error syncing ${repoSlug}: ${err}`);
            appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] syncSkills ERROR: ${repoSlug}: ${err}\n`);
          }
        }
      })(),
      timeoutPromise,
    ]);
  } finally {
    if (timedOut) {
      // Reset _synced so next setup() call can retry
      _synced = false;
      appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] _synced reset after timeout\n`);
    }
  }
}

export default Plugin.define({
  id: "skill-downloader",
  async setup(ctx) {
    // Debug: write to file to verify setup runs
    appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] setup called\n`);

    const options = (ctx.options || {}) as SkillDownloaderOptions;
    let skillUrls = options.skillUrls || [];

    // githubToken: explicit option > GITHUB_TOKEN env var
    const githubToken = options.githubToken ?? process.env.GITHUB_TOKEN;

    appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] options: ${JSON.stringify(options)}\n`);
    appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] skillUrls from options: ${JSON.stringify(skillUrls)}\n`);

    // Fallback: read from opencode.jsonc skills array
    if (skillUrls.length === 0) {
      appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] reading fallback config\n`);
      const fallbackUrls = await readSkillsFromConfig();
      appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] fallback urls: ${JSON.stringify(fallbackUrls)}\n`);
      if (fallbackUrls.length > 0) {
        skillUrls = fallbackUrls;
      }
    }

    if (skillUrls.length === 0) {
      appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] no skill URLs, returning\n`);
      console.log("[skill-downloader] No skill URLs configured, exiting.");
      return;
    }

    // Skip re-sync on subsequent setup() calls (hot-reload dedup)
    if (_synced) {
      appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] already synced, skipping\n`);
      console.log("[skill-downloader] Already synced, skipping duplicate setup() call.");
      return;
    }
    _synced = true;

    console.log(
      `[skill-downloader] Initialized with ${skillUrls.length} repository URLs.`,
    );
    appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] ${skillUrls.length} URLs, starting sync\n`);

    // Register /skills-refresh command
    await ctx.command.transform((editor) => {
      editor.add({
        name: "skills-refresh",
        description: "Refresh and update skills from GitHub repositories",
        execute: async ({ sessionID, prompt, delivery }) => {
          await performFullSync(ctx, skillUrls, { ...options, githubToken });
          // Send confirmation to the session
          await ctx.session.prompt({
            sessionID,
            text: `Skills refresh triggered. Updating from ${skillUrls.length} repositories...`,
            delivery,
          });
        },
      });
    });

    // Initial sync on load — fire-and-forget with timeout, don't block OpenCode startup
    (async () => {
      appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] Starting initial sync (fire-and-forget)\n`);
      appendFileSync(getLogPath(), `[${new Date().toISOString()}] [skill-downloader] Starting initial sync\n`);
      await performFullSync(ctx, skillUrls, { ...options, githubToken });
      appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] Initial sync complete\n`);
      appendFileSync(getLogPath(), `[${new Date().toISOString()}] [skill-downloader] Initial sync complete\n`);
    })();

    // Yield to event loop so OpenCode stays responsive during sync
    await new Promise((resolve) => setTimeout(resolve, 0));

    // One-shot: no background polling. Plugin stops after sync.
    // User must restart OpenCode to re-download.
    return () => {
      // Clear all pending rate limit retry timers
      for (const [repo, t] of _retryTimers) {
        clearTimeout(t);
      }
      _retryTimers.clear();
      console.log("[skill-downloader] Plugin unloaded, timers cleaned up.");
    };
  },
});
