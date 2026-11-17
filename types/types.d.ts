export interface GitHubRepoInfo {
    owner: string;
    repo: string;
    branch: string;
}
export interface GitHubContentItem {
    name: string;
    path: string;
    type: "file" | "dir";
    download_url: string;
    sha: string;
    html_url?: string;
}
export interface GitHubRelease {
    tag_name: string;
    html_url: string;
    created_at: string;
    sha?: string;
}
export interface SkillEntry {
    name: string;
    description: string;
    content: string;
    sha: string;
    path: string;
}
export interface SkillState {
    repoUrl: string;
    lastFetchedAt?: string;
    lastReleaseTag?: string;
    skills: Map<string, SkillEntry>;
}
export interface SkillDownloaderOptions {
    skillUrls?: string[];
    /** Auto-refresh in background. Default: false (one-shot only). */
    autoRefresh?: false;
    refreshIntervalMs?: number;
    githubToken?: string;
}
