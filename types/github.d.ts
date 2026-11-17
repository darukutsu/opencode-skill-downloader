import type { GitHubContentItem, GitHubRelease, GitHubRepoInfo } from "./types";
export declare const _rateLimitedRepos: Set<string>;
export declare const _retryTimers: Map<string, NodeJS.Timeout>;
/**
 * Parse a GitHub URL into owner/repo/branch components.
 * Supports:
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo/tree/branch
 *   git@github.com:owner/repo.git
 *   owner/repo
 */
export declare function parseGitHubUrl(url: string): GitHubRepoInfo | null;
/**
 * Fetch rate limit status from GitHub API.
 */
export declare function getRateLimit(token?: string): Promise<Record<string, unknown> | null>;
/**
 * Fetch the latest release for a repo via GitHub API.
 */
export declare function getLatestRelease(owner: string, repo: string, token?: string): Promise<GitHubRelease | null>;
/**
 * Fetch directory contents from a repo via GitHub Contents API.
 */
export declare function getContents(owner: string, repo: string, path: string, branch: string, token?: string): Promise<GitHubContentItem[]>;
/**
 * Fetch raw file content from a repo.
 */
export declare function getRawFile(owner: string, repo: string, path: string, branch: string, token?: string): Promise<string>;
/**
 * Discover skill directories in a repo.
 * Checks skills/, .agents/, and root-level skills.md.
 * Returns items with their GitHub sha for change detection.
 */
export declare function discoverSkills(owner: string, repo: string, branch: string, token?: string): Promise<{
    path: string;
    isDirectory: boolean;
    sha: string;
}[]>;
/**
 * Extract a skill description from SKILL.md content.
 * First line after # heading or first paragraph.
 */
export declare function extractDescription(content: string, name: string): string;
