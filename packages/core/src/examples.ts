/**
 * Example file management — save, load, and list JSON example files
 * with path traversal protection.
 */

import fs from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

export class ConfigError extends Error {}

// Keep dots and hyphens — event names like "transfer_order.approved" must map
// to a folder with the same name. Only strip characters that are truly illegal
// in file paths (slashes, null bytes, colons on Windows).
const sanitize = (s: string) => s.replace(/[/\\:*?"<>|\x00]/g, "_");

export function getExamplePaths(
  examplesDir: string,
  eventName: string,
  fileName?: string,
): { dir: string; filePath?: string } {
  const base = path.resolve(examplesDir);
  const dir = path.resolve(base, sanitize(eventName));

  if (!fileName) return { dir };

  const filePath = path.resolve(dir, sanitize(fileName));
  return { dir, filePath };
}

export function stripJsonSuffix(fileName: string): string {
  return fileName.replace(/\.json$/i, "");
}

export async function assertInsideDirectory(baseDir: string, targetPath: string): Promise<void> {
  const realBaseDir = await fs.realpath(baseDir);
  const realTargetPath = await fs.realpath(targetPath);
  if (realTargetPath !== realBaseDir && !realTargetPath.startsWith(`${realBaseDir}${path.sep}`)) {
    throw new ConfigError("Access denied");
  }
}

async function ensureExampleDir(baseDir: string, dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const stats = await fs.lstat(dir);
  if (stats.isSymbolicLink()) {
    throw new ConfigError("Access denied");
  }
  await assertInsideDirectory(baseDir, dir);
}

async function ensureExampleFile(baseDir: string, filePath: string): Promise<void> {
  const parentDir = path.dirname(filePath);
  await assertInsideDirectory(baseDir, parentDir);
  const stats = await fs.lstat(filePath);
  if (stats.isSymbolicLink()) {
    throw new ConfigError("Access denied");
  }
  await assertInsideDirectory(baseDir, filePath);
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * List saved example files for a given event name.
 */
export async function listSavedExamples(
  examplesDir: string,
  eventName: string,
): Promise<{ name: string; fileName: string }[]> {
  const paths = getExamplePaths(examplesDir, eventName);
  try {
    await ensureExampleDir(examplesDir, paths.dir);
    const files = await fs.readdir(paths.dir);
    return files
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({ name: f.replace(/\.json$/, ""), fileName: f }));
  } catch {
    return [];
  }
}

/**
 * Save a payload as a JSON example file.
 */
export async function saveExample(
  examplesDir: string,
  eventName: string,
  fileName: string,
  payload: Record<string, unknown>,
): Promise<{ success: boolean; path?: string; error?: string }> {
  const baseName = stripJsonSuffix(fileName);
  const paths = getExamplePaths(examplesDir, eventName, baseName);

  try {
    await ensureExampleDir(examplesDir, paths.dir);
    const filePath = `${paths.filePath}.json`;
    await fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf-8");
    return { success: true, path: `${baseName}.json` };
  } catch (err) {
    const message = err instanceof ConfigError ? err.message : err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

/**
 * Resolve the absolute path of a saved example file without reading it.
 * Useful when the caller wants to open the file directly (e.g. in an editor).
 */
export function resolveExamplePath(
  examplesDir: string,
  eventName: string,
  fileName: string,
): string {
  const paths = getExamplePaths(examplesDir, eventName, stripJsonSuffix(fileName));
  return `${paths.filePath}.json`;
}

/**
 * Load a previously saved JSON example file.
 */
export async function loadExample(
  examplesDir: string,
  eventName: string,
  fileName: string,
): Promise<{ payload: Record<string, unknown> }> {
  const paths = getExamplePaths(examplesDir, eventName, stripJsonSuffix(fileName));
  const filePath = `${paths.filePath}.json`;

  await ensureExampleFile(examplesDir, filePath);
  const content = await fs.readFile(filePath, "utf-8");
  const payload = JSON.parse(content) as Record<string, unknown>;
  return { payload };
}
