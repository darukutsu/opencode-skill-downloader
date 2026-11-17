import { join as pathJoin } from "path";

/**
 * Derive paths from the opencode config directory (~/.config/opencode).
 */
export function getConfigDir(): string {
  return pathJoin(process.env.HOME || process.env.USERPROFILE || "/root", ".config", "opencode");
}

export function getSkillsDir(): string {
  return pathJoin(getConfigDir(), "skills");
}

export function getLogDir(): string {
  return pathJoin(process.env.HOME || process.env.USERPROFILE || "/root", ".local", "share", "opencode", "log");
}

export function getLogPath(): string {
  return pathJoin(getLogDir(), "opencode.log");
}

// Re-export for convenience
export const join = pathJoin;
