/**
 * EventBridge sending — sends events to AWS EventBridge.
 */

import {
  EventBridgeClient,
  PutEventsCommand,
} from "@aws-sdk/client-eventbridge";
import { fromIni } from "@aws-sdk/credential-provider-ini";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface EventBridgeConfig {
  busName: string;
  source: string;
  region: string;
  profile?: string;
}

export function getDefaultEventBridgeConfig(): EventBridgeConfig {
  return {
    busName: process.env.EVENT_BUS_NAME ?? "my-event-bus",
    source: process.env.EVENT_SOURCE ?? "event-artillery",
    region: process.env.AWS_REGION ?? "us-east-1",
    profile: process.env.AWS_PROFILE,
  };
}

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

export function createEventBridgeClient(config: EventBridgeConfig): EventBridgeClient {
  return new EventBridgeClient({
    region: config.region,
    credentials: config.profile ? fromIni({ profile: config.profile }) : undefined,
    maxAttempts: 3,
  });
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

export interface SendEventResult {
  success: boolean;
  eventId?: string;
  error?: string;
}

/**
 * Send an event to AWS EventBridge.
 */
export async function sendEvent(
  client: EventBridgeClient,
  config: EventBridgeConfig,
  eventName: string,
  payload: Record<string, unknown>,
): Promise<SendEventResult> {
  const result = await client.send(
    new PutEventsCommand({
      Entries: [
        {
          Source: config.source,
          DetailType: eventName,
          Detail: JSON.stringify(payload),
          EventBusName: config.busName,
        },
      ],
    }),
  );

  if (result.FailedEntryCount && result.FailedEntryCount > 0) {
    const entry = result.Entries?.[0];
    const error = entry?.ErrorCode
      ? `${entry.ErrorCode}: ${entry.ErrorMessage}`
      : "Unknown EventBridge error";
    return { success: false, error };
  }

  const eventId = result.Entries?.[0]?.EventId;
  return { success: true, eventId };
}
