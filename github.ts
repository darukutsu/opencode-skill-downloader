import type { GitHubContentItem, GitHubRelease, GitHubRepoInfo } from "./types";
import { appendFileSync } from "fs";

const USER_AGENT = "OpenCode-Skill-Downloader";

// Track 403 rate limits per repo to stop burning through 60/hr unauthenticated limit
export const _rateLimitedRepos = new Set<string>();
export const _retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Clear pending retry timer for a repo.
 */
function clearRetryTimer(repoSlug: string): void {
  const timer = _retryTimers.get(repoSlug);
  if (timer) {
    clearTimeout(timer);
    _retryTimers.delete(repoSlug);
  }
}

/**
 * Schedule a retry for a rate-limited repo once the rate limit resets.
 */
function scheduleRetry(repoSlug: string, resetTime: number): void {
  clearRetryTimer(repoSlug);
  const waitMs = Math.max(0, resetTime - Date.now() / 1000) * 1000 + 1000; // +1s buffer
  _retryTimers.set(repoSlug, setTimeout(() => {
    _rateLimitedRepos.delete(repoSlug);
    _retryTimers.delete(repoSlug);
    console.log(`[skill-downloader] Rate limit reset for ${repoSlug}, retrying.`);
  }, waitMs));
  appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] Scheduled retry for ${repoSlug} in ${Math.round(waitMs / 1000)}s (reset at ${new Date(resetTime * 1000).toISOString()})\n`);
}

/**
 * Parse a GitHub URL into owner/repo/branch components.
 * Supports:
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo/tree/branch
 *   git@github.com:owner/repo.git
 *   owner/repo
 */
export function parseGitHubUrl(url: string): GitHubRepoInfo | null {
  // SSH format: git@github.com:owner/repo.git
  const sshMatch = url.match(/^git@github\.com:([^/]+)\/([^/.]+)(?:\.git)?$/);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2], branch: "main" };
  }

  // Shorthand: owner/repo
  const shorthandMatch = url.match(/^([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)$/);
  if (shorthandMatch) {
    return { owner: shorthandMatch[1], repo: shorthandMatch[2], branch: "main" };
  }

  // Full URL: https://github.com/owner/repo or with /tree/branch
  const urlMatch = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/tree\/([^/]+))?/);
  if (urlMatch) {
    return {
      owner: urlMatch[1],
      repo: urlMatch[2],
      branch: urlMatch[3] || "main",
    };
  }

  return null;
}

/**
 * Build request headers with optional auth token.
 */
function buildHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": USER_AGENT,
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

/**
 * Check if a 403 response is a rate limit (X-RateLimit-Remaining: 0) or an auth error.
 */
async function isRateLimit(resp: Response): Promise<boolean> {
  if (resp.status !== 403) return false;
  const remaining = resp.headers.get("X-RateLimit-Remaining");
  if (remaining !== null) {
    return parseInt(remaining, 10) === 0;
  }
  // No header — assume rate limit to be safe
  return true;
}

/**
 * Retry logic: try token first, then fall back to unauthenticated if rate-limited (403).
 * Rate-limit tracking: stops making requests after confirmed rate limit to avoid burning 60/hr limit.
 */
async function withFallbackRetry<T>(
  fn: (token: string | undefined) => Promise<{ ok: boolean; status: number; data: T; resp?: Response }>,
  token: string | undefined,
  repoSlug: string,
  operation: string,
): Promise<T | null> {
  // 1. Try with token first (higher rate limit: 5000/hr vs 60/hr)
  if (token) {
    const authResult = await fn(token);
    appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] withFallbackRetry: ${repoSlug} ${operation} auth-first status=${authResult.status} ok=${authResult.ok}\n`);
    if (authResult.ok) {
      return authResult.data;
    }
    // Token failed — check if it's rate limit or auth error
    if (authResult.status === 403) {
      const rateLimited = authResult.resp ? await isRateLimit(authResult.resp) : true;
      if (rateLimited) {
        appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] withFallbackRetry: ${repoSlug} ${operation} auth rate-limited, falling back to unauth\n`);
        // Schedule auto-retry when rate limit resets
        const resetHeader = authResult.resp?.headers.get("X-RateLimit-Reset");
        if (resetHeader) {
          const resetTime = parseInt(resetHeader, 10);
          scheduleRetry(repoSlug, resetTime);
        }
      } else {
        appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] withFallbackRetry: ${repoSlug} ${operation} auth 403 but rate limit remaining > 0 — token likely invalid\n`);
        console.log(`[skill-downloader] Token appears invalid for ${repoSlug} ${operation} (HTTP 403, rate limit remaining > 0). Trying unauthenticated.`);
      }
    } else if (authResult.status === 401) {
      console.log(`[skill-downloader] Token auth failed for ${repoSlug} ${operation} (HTTP 401), trying unauthenticated.`);
    }
  }

  // 2. Fallback to unauthenticated
  const unauthResult = await fn(undefined);
  appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] withFallbackRetry: ${repoSlug} ${operation} unauth status=${unauthResult.status} ok=${unauthResult.ok}\n`);
  if (unauthResult.ok) {
    return unauthResult.data;
  }

  // Mark repo as rate-limited on confirmed 403 to stop burning through 60/hr
  if (unauthResult.status === 403) {
    const rateLimited = unauthResult.resp ? await isRateLimit(unauthResult.resp) : true;
    if (rateLimited) {
      _rateLimitedRepos.add(repoSlug);
      // Schedule auto-retry when rate limit resets
      const resetHeader = unauthResult.resp?.headers.get("X-RateLimit-Reset");
      if (resetHeader) {
        const resetTime = parseInt(resetHeader, 10);
        scheduleRetry(repoSlug, resetTime);
      }
      console.log(`[skill-downloader] Rate limited (403) for ${repoSlug}, retrying at reset.`);
    } else {
      console.log(`[skill-downloader] Unauthenticated request returned 403 for ${repoSlug} (rate limit remaining > 0), skipping.`);
    }
  }

  // Both failed
  return null;
}

/**
 * Fetch rate limit status from GitHub API.
 */
export async function getRateLimit(token?: string): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const resp = await fetch("https://api.github.com/rate_limit", {
      headers: buildHeaders(token),
      signal: controller.signal,
    });
    if (resp.ok) {
      return (await resp.json()) as any;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch the latest release for a repo via GitHub API.
 */
export async function getLatestRelease(
  owner: string,
  repo: string,
  token?: string,
): Promise<GitHubRelease | null> {
  const repoSlug = `${owner}/${repo}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const result = await withFallbackRetry(
      async (t) => {
        const resp = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/releases/latest`,
          {
            headers: buildHeaders(t),
            signal: controller.signal,
          },
        );
        if (resp.ok) {
          const data = (await resp.json()) as GitHubRelease;
          return { ok: true, status: resp.status, data, resp };
        }
        return { ok: false, status: resp.status, data: null as unknown as GitHubRelease, resp };
      },
      token,
      repoSlug,
      "getLatestRelease",
    );

    return result;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch directory contents from a repo via GitHub Contents API.
 */
export async function getContents(
  owner: string,
  repo: string,
  path: string,
  branch: string,
  token?: string,
): Promise<GitHubContentItem[]> {
  const repoSlug = `${owner}/${repo}`;
  appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] getContents ENTER: ${repoSlug} path=${path}\n`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const result = await withFallbackRetry(
      async (t) => {
        const resp = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`,
          {
            headers: buildHeaders(t),
            signal: controller.signal,
          },
        );
        if (resp.ok) {
          const rawData = await resp.json();
          // GitHub returns a single object for file paths, array for directory paths
          const data = Array.isArray(rawData) ? rawData : [rawData];
          return { ok: true, status: resp.status, data, resp };
        }
        return { ok: false, status: resp.status, data: [] as GitHubContentItem[], resp };
      },
      token,
      repoSlug,
      `getContents(${path})`,
    );

    return result ?? [];
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch raw file content from a repo.
 */
export async function getRawFile(
  owner: string,
  repo: string,
  path: string,
  branch: string,
  token?: string,
): Promise<string> {
  const repoSlug = `${owner}/${repo}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const result = await withFallbackRetry(
      async (t) => {
        const headers: Record<string, string> = {
          "User-Agent": USER_AGENT,
        };
        if (t) {
          headers["Authorization"] = `Bearer ${t}`;
        }
        const resp = await fetch(
          `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${encodeURIComponent(path)}`,
          {
            headers,
            signal: controller.signal,
          },
        );
        if (resp.ok) {
          const data = await resp.text();
          return { ok: true, status: resp.status, data, resp };
        }
        return { ok: false, status: resp.status, data: "", resp };
      },
      token,
      repoSlug,
      `getRawFile(${path})`,
    );

    return result ?? "";
  } catch {
    return "";
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Recursively discover SKILL.md files in a directory tree.
 * Returns paths to all SKILL.md files found.
 */
async function findSkillMdFiles(
  owner: string,
  repo: string,
  dirPath: string,
  branch: string,
  token?: string,
  depth: number = 0,
): Promise<string[]> {
  const items = await getContents(owner, repo, dirPath, branch, token);
  if (items.length === 0) return [];

  const results: string[] = [];
  const dirsToExplore: string[] = [];

  for (const item of items) {
    if (item.type === "file" && item.name.toLowerCase() === "skill.md") {
      const fullPath = dirPath ? `${dirPath}/${item.name}` : item.name;
      results.push(fullPath);
    } else if (item.type === "dir" && depth < 5) {
      // Recurse into subdirectories (limit depth to 5 levels)
      const subPath = dirPath ? `${dirPath}/${item.name}` : item.name;
      dirsToExplore.push(subPath);
    }
  }

  // Recurse into subdirectories
  for (const subPath of dirsToExplore) {
    const subResults = await findSkillMdFiles(owner, repo, subPath, branch, token, depth + 1);
    results.push(...subResults);
  }

  return results;
}

/**
 * Discover skill directories in a repo.
 * Checks skills/, .agents/, and root-level skills.md.
 * Returns items with their GitHub sha for change detection.
 */
export async function discoverSkills(
  owner: string,
  repo: string,
  branch: string,
  token?: string,
): Promise<{ path: string; isDirectory: boolean; sha: string }[]> {
  const repoSlug = `${owner}/${repo}`;
  appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] discoverSkills ENTER: ${repoSlug}\n`);
  const candidates = ["skills", ".agents"];

  const results: { path: string; isDirectory: boolean; sha: string }[] = [];

  for (const candidate of candidates) {
    const items = await getContents(owner, repo, candidate, branch, token);
    appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] discoverSkills: ${repoSlug} getContents(${candidate}) returned ${items.length} items\n`);
    if (items.length === 0) continue;

    // Recursively find SKILL.md files in this directory tree
    const skillMdPaths = await findSkillMdFiles(owner, repo, candidate, branch, token);
    appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] discoverSkills: ${repoSlug} ${candidate} found ${skillMdPaths.length} SKILL.md files\n`);

    for (const skillMdPath of skillMdPaths) {
      appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] discoverSkills: ${repoSlug} processing skill: ${skillMdPath}\n`);
      // Get the sha of the SKILL.md file itself
      const fileItems = await getContents(owner, repo, skillMdPath, branch, token);
      appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] discoverSkills: ${repoSlug} getContents(${skillMdPath}) returned ${fileItems?.length ?? 0} items\n`);
      const skillFile = fileItems?.find((i: { name: string }) => i.name.toLowerCase() === "skill.md");
      if (skillFile) {
        results.push({ path: skillMdPath, isDirectory: false, sha: skillFile.sha });
        appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] discoverSkills: ${repoSlug} added ${skillMdPath} sha=${skillFile.sha}\n`);
      } else {
        appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] discoverSkills: ${repoSlug} NO skill.md found in getContents(${skillMdPath})\n`);
      }
    }
  }

  // Check for root-level skills.md
  const rootItems = await getContents(owner, repo, "", branch, token);
  appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] discoverSkills: ${repoSlug} getContents(root) returned ${rootItems.length} items\n`);
  for (const item of rootItems) {
    if (item.type === "file" && item.name.toLowerCase() === "skills.md") {
      results.push({ path: "skills.md", isDirectory: false, sha: item.sha });
    }
  }

  appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] discoverSkills: ${repoSlug} total results: ${results.length}\n`);
  appendFileSync("/tmp/opencode-skill-downloader-debug.log", `[${new Date().toISOString()}] discoverSkills: ${repoSlug} RETURNING ${results.length} results\n`);
  return results;
}

/**
 * Extract a skill description from SKILL.md content.
 * First line after # heading or first paragraph.
 */
export function extractDescription(content: string, name: string): string {
  // Try first line after # heading
  const headingMatch = content.match(/^#\s+(.+)$/m);
  if (headingMatch) {
    const line = headingMatch[1].trim();
    if (line.length > 0 && line.length < 200) return line;
  }

  // Try first paragraph
  const paragraphMatch = content.match(/^\n?(.+?)(?=\n\n|\n#|$)/s);
  if (paragraphMatch) {
    const line = paragraphMatch[1].trim();
    if (line.length > 0 && line.length < 200) return line;
  }

  return name;
}
