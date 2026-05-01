/**
 * Path resolution and config utilities.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

export interface PathsConfig {
  baseDir: string;
  eventsYamlPath: string;
  examplesDir: string;
}

export { ConfigError } from "./examples.js";

export function resolveFromBase(baseDir: string, value: string | undefined, fallbackRelativePath: string): string {
  if (!value) return path.resolve(baseDir, fallbackRelativePath);
  return path.isAbsolute(value) ? value : path.resolve(baseDir, value);
}

export function fileUriToPath(uri: string): string | null {
  try {
    if (!uri.startsWith("file://")) return null;
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}
