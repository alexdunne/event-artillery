/**
 * AWS auth check — uses the AWS SDK's credential provider chain to verify
 * credentials without relying on the AWS CLI being on PATH.
 *
 * Uses STSClient.GetCallerIdentity which is a zero-permission call that
 * simply returns the identity of whoever is calling it.
 *
 * fromNodeProviderChain() handles the full chain:
 *   env vars → SSO token cache → shared ini/credentials files → process credentials
 */

import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { defaultProvider } from "@aws-sdk/credential-provider-node";

export interface AwsAuthStatus {
  authenticated: boolean;
  identity?: { account: string; arn: string; userId: string };
  error?: string;
}

export async function checkAwsAuth(profile?: string): Promise<AwsAuthStatus> {
  try {
    const credentials = defaultProvider({
      profile: profile || undefined,
    });

    const client = new STSClient({
      // Use a fixed region for STS — the global endpoint works everywhere
      region: "us-east-1",
      credentials,
    });

    const response = await client.send(new GetCallerIdentityCommand({}));

    return {
      authenticated: true,
      identity: {
        account: response.Account ?? "unknown",
        arn: response.Arn ?? "unknown",
        userId: response.UserId ?? "unknown",
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const reason = classifyError(message);
    return { authenticated: false, error: reason };
  }
}

function classifyError(message: string): string {
  if (message.includes("ExpiredToken") || message.includes("expired")) {
    return "Token expired — please log in again.";
  }
  if (message.includes("InvalidClientTokenId") || message.includes("InvalidToken")) {
    return "Invalid credentials — please log in again.";
  }
  if (
    message.includes("NoCredentialsError") ||
    message.includes("Could not load credentials") ||
    message.includes("Unable to load SSO token") ||
    message.includes("Token for") // SSO token missing from cache
  ) {
    return "Not logged in — SSO token not found.";
  }
  if (message.includes("Profile") && message.includes("not found")) {
    return `AWS profile not found in ~/.aws/config.`;
  }
  return `Not authenticated: ${message}`;
}
