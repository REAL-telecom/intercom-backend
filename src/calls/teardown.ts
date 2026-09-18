import { env } from "../config/env";
import { claimBridgeTeardown } from "../store/redis";
import { hangupChannelIfExists, deleteBridge, getBridge, isAriNotFound } from "../ari/client";

import type { FastifyBaseLogger } from "fastify";

export type TeardownBridgeLog = {
  callId?: string;
  channelId?: string;
  source: "channelLeftBridge" | "stasisEnd" | "timedOut" | "callsEnd" | "setupFailed";
};

/**
 * Tear down a mixing bridge once: hang up remaining legs, then delete the bridge.
 * First caller wins via claimBridgeTeardown; later callers return immediately.
 * skipChannelId is the panel channel already sent to dialplan (timeout and reject paths); do not hang it up.
 */
export const teardownBridge = async (
  bridgeId: string,
  skipChannelId: string | undefined,
  log: TeardownBridgeLog,
  logger: FastifyBaseLogger
): Promise<void> => {
  const claimed = await claimBridgeTeardown(bridgeId, env.callTokenTtlSec);
  if (!claimed) {
    return;
  }
  try {
    const bridgeInfo = await getBridge(bridgeId);
    let hangupFailed = false;
    if (bridgeInfo?.channels?.length) {
      for (const chId of bridgeInfo.channels) {
        if (chId === skipChannelId) continue;
        const hangupResult = await hangupChannelIfExists(chId);
        if (hangupResult === "hung_up") {
          logger.info({ ...log, bridgeId, channelId: chId }, `${log.source}: hung up channel in bridge`);
        } else if (hangupResult === "failed") {
          hangupFailed = true;
        }
      }
    }
    if (hangupFailed) {
      logger.warn({ bridgeId, ...log }, `${log.source}: skipping bridge delete, channel hangup failed`);
    } else {
      await deleteBridge(bridgeId);
      logger.info({ bridgeId, ...log }, `${log.source}: bridge deleted`);
    }
  } catch (error) {
    if (isAriNotFound(error)) {
      logger.debug({ err: error, bridgeId, ...log }, `${log.source}: bridge already deleted or cleanup failed`);
    } else {
      logger.warn({ err: error, bridgeId, ...log }, `${log.source}: bridge already deleted or cleanup failed`);
    }
  }
};
