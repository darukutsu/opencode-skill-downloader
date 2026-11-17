import { Plugin, Skill } from "@opencode/plugin";
import {
  getContents,
  getRawFile,
  discoverSkills,
  extractDescription,
  getRateLimit,
} from "./github.js";
import { SkillStorage } from "./storage.js";
import { getLogPath, getSkillsDir, join } from "./paths.js";
import type { GitHubRepoInfo, SkillEntry, SkillDownloaderOptions } from "./types.js";
import { appendFileSync } from "fs";
import { mkdirSync, writeFileSync } from "fs";

const SKILL_ROOT = getSkillsDir();
const LOG_PATH = getLogPath();

/**
 * Write a skill's SKILL.md to the local skills directory.
 */
function writeSkillToDisk(repoSlug: string, skillName: string, content: string): string {
  const skillDir = join(SKILL_ROOT, repoSlug, skillName);
  mkdirSync(skillDir, { recursive: true });
  const filePath = join(skillDir, "SKILL.md");
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

/**
 * Sync skills from a GitHub repo to local storage and register them.
 */
export async function syncSkills(
  ctx: Plugin.Context,
  repoInfo: GitHubRepoInfo,
  storage: SkillStorage,
  options: SkillDownloaderOptions,
): Promise<{ downloaded: number; updated: number; errors: string[] }> {
  const { owner, repo, branch } = repoInfo;
  const repoSlug = `${owner}/${repo}`;
  const errors: string[] = [];
  let downloaded = 0;
  let updated = 0;

  appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] syncSkills: ${repoSlug}, branch=${branch}\n`);

  try {
  // Step 2: Discover skill directories
  appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] syncSkills: ${repoSlug} calling discoverSkills\n`);
  const skillPaths = await discoverSkills(owner, repo, branch, options.githubToken);
  appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] syncSkills: ${repoSlug} discoverSkills returned ${skillPaths.length} paths\n`);
  appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] syncSkills: ${repoSlug} IMMEDIATELY AFTER discoverSkills\n`);

  // Log rate limit status
  appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] syncSkills: ${repoSlug} step0: checking rate limit\n`);
  const rateLimit = await getRateLimit(options.githubToken);
  appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] syncSkills: ${repoSlug} step0: rateLimit=${rateLimit ? 'set' : 'null'}\n`);
  if (rateLimit) {
    const rl = rateLimit as any;
    appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] syncSkills: ${repoSlug} rateLimit raw keys: ${Object.keys(rl).join(',')}\n`);
    appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] syncSkills: ${repoSlug} rateLimit.rate: ${JSON.stringify(rl.rate)}\n`);
    const core = rl?.rate?.core ?? rl?.core;
    if (core) {
      const msg = `[skill-downloader] Rate limit: core ${core.remaining}/${core.limit} (reset: ${new Date(core.reset * 1000).toISOString()})`;
      console.log(msg);
      appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] ${msg}\n`);
      // Also write to opencode log for user visibility
      appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`);
    } else {
      appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] syncSkills: ${repoSlug} core is undefined, skipping rate limit log\n`);
    }
  }

  // Step 1: Get existing state
  appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] syncSkills: ${repoSlug} step1: get existing state\n`);
  const existingState = await storage.getState();
  appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] syncSkills: ${repoSlug} step1: existingState=${existingState ? 'set' : 'null'}\n`);
  const existingSkills = existingState?.skills || new Map();
  appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] syncSkills: ${repoSlug} step1: existingSkills.size=${existingSkills.size}\n`);

  // If no skills stored yet (first run), do full download
  if (existingSkills.size === 0) {
    appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] syncSkills: ${repoSlug} first run, full download\n`);
  }
  if (skillPaths.length === 0) {
    console.log(`[skill-downloader] No skills found in ${repoSlug}`);
    appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] syncSkills: ${repoSlug} early return: no skill paths\n`);
    return { downloaded: 0, updated: 0, errors: [] };
  }

  console.log(`[skill-downloader] Found ${skillPaths.length} skill entries in ${repoSlug}`);
  appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] syncSkills: ${repoSlug} step2: processing ${skillPaths.length} skills\n`);

  // Step 3: For each discovered skill, check if it needs download/update
  const newSkills = new Map<string, SkillEntry>();
  const seenNames = new Set<string>();
  appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] syncSkills: ${repoSlug} step2: loop start, newSkills=${newSkills.size}\n`);

  for (const skillPath of skillPaths) {
    appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] syncSkills: ${repoSlug} loop iteration: skillPath=${skillPath.path}\n`);
    try {
      // Extract skill name and path
      let skillMdPath: string;
      let skillName: string;

      if (skillPath.path === "skills.md") {
        skillName = "skills";
        skillMdPath = "skills.md";
      } else if (skillPath.path.endsWith("/SKILL.md")) {
        skillMdPath = skillPath.path;
        const withoutPrefix = skillPath.path.replace(/^skills\/|\.agents\//, "");
        const parts = withoutPrefix.split("/");
        skillName = parts.slice(0, -1).join("/");
      } else {
        skillName = skillPath.path.split("/").pop() || skillPath.path;
        skillMdPath = `${skillPath.path}/SKILL.md`;
      }

      seenNames.add(skillName);

      // Check if skill exists locally with matching sha
      const existing = existingSkills.get(skillName);
      if (existing && existing.sha === skillPath.sha) {
        // Already up to date, skip
        appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] syncSkills: ${repoSlug} skip ${skillName} (sha match)\n`);
        continue;
      }

      // Fetch content
      appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] syncSkills: ${repoSlug} getRawFile ${skillName}\n`);
      const content = await getRawFile(owner, repo, skillMdPath, branch, options.githubToken);
      appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] syncSkills: ${repoSlug} getRawFile ${skillName} contentLen=${content.length}\n`);
      if (!content) {
        console.log(`[skill-downloader] No SKILL.md in ${skillPath.path}, skipping`);
        appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] syncSkills: ${repoSlug} empty content ${skillName}\n`);
        continue;
      }

      const desc = extractDescription(content, skillName);
      appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] syncSkills: ${repoSlug} writeSkillToDisk ${skillName}\n`);
      const fsPath = writeSkillToDisk(repoSlug, skillName, content);

      const entry: SkillEntry = {
        name: skillName,
        description: desc,
        content,
        sha: skillPath.sha,
        path: fsPath,
      };

      newSkills.set(skillName, entry);
      if (existing) {
        updated++;
      } else {
        downloaded++;
      }
    } catch (err) {
      const errMsg = `Error processing ${skillPath.path}: ${err}`;
      console.log(`[skill-downloader] ${errMsg}`);
      appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] syncSkills: ${repoSlug} ERROR ${errMsg}\n`);
      errors.push(errMsg);
    }
  }

  appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] syncSkills: ${repoSlug} loop done: newSkills=${newSkills.size} downloaded=${downloaded} updated=${updated}\n`);

  appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] syncSkills: ${repoSlug} loop done: newSkills=${newSkills.size} downloaded=${downloaded} updated=${updated}\n`);

  // Step 4: Remove skills that no longer exist in the repo
  appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] syncSkills: ${repoSlug} step4: removing old skills\n`);
  const removedSkills: string[] = [];
  for (const [name, entry] of existingSkills) {
    if (!seenNames.has(name)) {
      removedSkills.push(name);
      // Remove from editor
      await ctx.skill.transform((editor) => {
        editor.remove(name);
      });
    }
  }

  // Step 5: Register new/updated skills via ctx.skill.transform
  appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] syncSkills: ${repoSlug} step5: register ${newSkills.size} skills\n`);
  if (newSkills.size > 0) {
    await ctx.skill.transform((editor) => {
      for (const [name, entry] of newSkills) {
        const existing = editor.get(name);
        if (existing) {
          editor.update(name, (skill) => {
            skill.description = entry.description;
            skill.content = entry.content;
          });
        } else {
          editor.add({
            id: Skill.ID.make(`${repoSlug}/${name}`),
            name: Skill.Name.make(name),
            description: entry.description,
            path: Skill.Info.fields.path.make(entry.path),
            content: entry.content,
          });
        }
      }
    });

    await ctx.skill.reload();
  }

  // Step 6: Update storage state
  appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] syncSkills: ${repoSlug} step6: update storage\n`);
  const allSkills = new Map(existingSkills);
  for (const [name, entry] of newSkills) {
    allSkills.set(name, entry);
  }
  for (const name of removedSkills) {
    allSkills.delete(name);
  }

  await storage.setState({
    repoUrl: `https://github.com/${repoSlug}`,
    lastFetchedAt: new Date().toISOString(),
    lastReleaseTag: undefined,
    skills: allSkills,
  });

  console.log(`[skill-downloader] ${repoSlug}: ${downloaded} downloaded, ${updated} updated, ${removedSkills.length} removed`);
  appendFileSync(LOG_PATH, `[${new Date().toISOString()}] [skill-downloader] ${repoSlug}: ${downloaded} downloaded, ${updated} updated, ${removedSkills.length} removed\n`);
  appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] syncSkills: ${repoSlug} COMPLETE\n`);

  } catch (err) {
    appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] syncSkills: ${repoSlug} THREW ERROR: ${err}\n`);
    throw err;
  }

  return { downloaded, updated, errors };
}
