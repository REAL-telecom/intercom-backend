import { FastifyInstance } from "fastify";
import { env } from "../../config";
import { hangupChannel } from "../../ari";
import { cleanupBridge } from "../bridges/cleanup";
import { armEndpointRemoval } from "../endpoints";
import { notifyCallOver } from "../../push/notifyCallOver";
import {
  deleteOriginate,
  deletePanel,
  getCall,
  getChannel,
  getDialStatus,
  listDialedChannels,
  setDialStatus,
} from "../../store/redis";

import type { AriEvent, CallData, ChannelSession } from "../../types";

export const onStasisEnd = async (event: AriEvent, app: FastifyInstance) => {
  const channel = event.channel as { id?: string };
  if (!channel.id) return;
  const channelId = channel.id;

  app.log.info({ channelId }, "StasisEnd - channel terminated, cleaning up bridge");

  const channelSession = await getChannel<ChannelSession>(channelId);
  let callData: CallData | null = null;
  if (channelSession?.callId) {
    callData = await getCall<CallData>(channelSession.callId);
  }
  const bridgeId = callData?.bridgeId ?? channelSession?.bridgeId;
  if (bridgeId) {
    await cleanupBridge(bridgeId, undefined, { channelId, source: "stasisEnd" }, app.log);
  } else {
    app.log.debug({ channelId }, "No bridgeId in channel session or call data, skipping bridge cleanup");
  }

  const callId = channelSession?.callId;
  if (callId && callData) {
    const claimed = await setDialStatus(callId, "canceled", env.callTokenTtlSec);
    if (claimed) {
      if (callData.endpointId) {
        try {
          await deleteOriginate(callData.endpointId);
          app.log.info(
            { callId, endpointId: callData.endpointId, channelId },
            "StasisEnd: cleared pending originate for ended pending call"
          );
        } catch (pendingError) {
          app.log.warn(
            { err: pendingError, callId, endpointId: callData.endpointId, channelId },
            "StasisEnd: failed to clear pending originate for ended pending call"
          );
        }
      }
    }

    const originateChannelIds = await listDialedChannels(callId);
    for (const originateChannelId of originateChannelIds) {
      if ((await hangupChannel(originateChannelId, app.log)) === "hungUp") {
        app.log.info({ originateChannelId, channelId, callId }, "StasisEnd: hung up originate channel");
      }
    }

    if (claimed) {
      await notifyCallOver(callId, callData, "caller_hung_up", app.log);
    } else {
      const outcome = await getDialStatus(callId);
      if (outcome === "accepted") {
        await notifyCallOver(callId, callData, "ended", app.log);
      }
    }

    if (callData.domophoneEndpointId) {
      await deletePanel(callData.domophoneEndpointId);
    }

    if (callData.endpointId) {
      const outcome = await getDialStatus(callId);
      if (outcome !== null) {
        armEndpointRemoval(callData.endpointId, { callId, channelId, source: "stasisEnd" }, app);
      }
    }
  }

  // Redis will cleanup session data automatically by TTL
};
