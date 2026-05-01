/**
 * AWS profile picker — reads ~/.aws/config to list all available profiles,
 * without relying on the AWS CLI being on PATH.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface AwsProfile {
  name: string;
  ssoAccountId?: string;
  region?: string;
}

/**
 * Parse ~/.aws/config and return all named profiles.
 * Sections look like [profile foo] or [default].
 */
export async function listAwsProfiles(): Promise<AwsProfile[]> {
  const configPath = path.join(os.homedir(), ".aws", "config");
  let content: string;
  try {
    content = await fs.readFile(configPath, "utf-8");
  } catch {
    return [];
  }

  const profiles: AwsProfile[] = [];
  let current: AwsProfile | null = null;

  for (const raw of content.split("\n")) {
    const line = raw.trim();

    // Section header: [profile foo] or [default]
    const profileMatch = line.match(/^\[profile\s+(.+?)\]$/) ?? line.match(/^\[default\]$/);
    if (profileMatch) {
      if (current) profiles.push(current);
      current = { name: profileMatch[1] ?? "default" };
      continue;
    }

    if (!current) continue;

    const kvMatch = line.match(/^([\w_]+)\s*=\s*(.+)$/);
    if (!kvMatch) continue;
    const [, key, value] = kvMatch;

    if (key === "sso_account_id") current.ssoAccountId = value;
    if (key === "region") current.region = value;
  }

  if (current) profiles.push(current);
  return profiles;
}
