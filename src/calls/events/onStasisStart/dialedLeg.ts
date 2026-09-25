import { FastifyInstance } from "fastify";
import { env } from "../../../config";
import {
  addChannelToBridge,
  answerChannel,
  continueInDialplan,
  getBridge,
  hangupChannel,
} from "../../../ari";
import { notifyCallOver } from "../../../push/notifyCallOver";
import {
  getCall,
  getCallId,
  getDialStatus,
  listDialedChannels,
  setChannel,
  setDialStatus,
} from "../../../store/redis";

import type { AriEvent, CallData } from "../../../types";

export const onDialedLeg = async (
  event: AriEvent,
  channelId: string,
  eventArgs: unknown[],
  app: FastifyInstance
) => {
  const bridgeId = String(eventArgs[1] ?? "");
  const endpointIdFromArgs = String(eventArgs[2] ?? "");
  const callIdForStatus = endpointIdFromArgs ? getCallId(endpointIdFromArgs) : null;
  if (bridgeId) {
    if (callIdForStatus) {
      const claimed = await setDialStatus(callIdForStatus, "accepted", env.callTokenTtlSec);
      if (!claimed) {
        const outcome = await getDialStatus(callIdForStatus);
        if (outcome === "accepted") {
          await hangupChannel(channelId, app.log, "answered_elsewhere");
        } else {
          await hangupChannel(channelId, app.log, "normal");
        }
        app.log.info(
          { channelId, callId: callIdForStatus, outcome },
          "Outgoing channel lost race or call already ended"
        );
        return;
      }
      app.log.info({ callId: callIdForStatus }, "Call marked as accepted (timeout will not hang up)");
      const acceptedCallData = await getCall<CallData>(callIdForStatus);
      if (acceptedCallData) {
        await notifyCallOver(
          callIdForStatus,
          acceptedCallData,
          "answered_elsewhere",
          app.log
        );
      } else {
        app.log.warn(
          { callId: callIdForStatus },
          "No call data for answered_elsewhere push, skipping push"
        );
      }
    } else {
      app.log.warn(
        { channelId, args: event.args },
        "Could not derive callId from outgoing channel args, skipping outcome claim"
      );
    }
    let connected = false;
    try {
      app.log.info({ channelId, bridgeId }, "Processing outgoing channel - adding to bridge");

      // Give the channel time to initialize
      await new Promise((r) => setTimeout(r, 200));

      // Add the channel to the bridge
      await addChannelToBridge(bridgeId, channelId);
      app.log.info({ channelId, bridgeId }, "Outgoing channel successfully added to bridge");

      // Store bridgeId in outgoing channel session for cleanup
      await setChannel(
        channelId,
        { bridgeId },
        env.callTokenTtlSec
      );

      // Now we need to answer the domophone channel
      // Get bridge info to find the domophone channel
      try {
        // Give the client channel time to fully initialize
        await new Promise((r) => setTimeout(r, 300));

        const bridgeInfo = await getBridge(bridgeId);
        app.log.info({ bridgeId, channels: bridgeInfo.channels, currentChannel: channelId }, "Bridge info retrieved");

        if (bridgeInfo.channels && bridgeInfo.channels.length > 0) {
          // Find the domophone channel (not the current outgoing channel)
          const domophoneChannelId = bridgeInfo.channels.find((ch: string) => ch !== channelId);
          if (domophoneChannelId) {
            app.log.info({ domophoneChannelId, bridgeId, allChannels: bridgeInfo.channels }, "Found domophone channel in bridge, answering it");
            try {
              await answerChannel(domophoneChannelId);
              connected = true;
              app.log.info({ domophoneChannelId }, "CRITICAL: Answered domophone channel - call should be fully connected now");
            } catch (answerError) {
              app.log.warn({ err: answerError, domophoneChannelId }, "Failed to answer domophone channel, may already be answered");
            }
          } else {
            app.log.warn({ bridgeId, channels: bridgeInfo.channels, currentChannel: channelId }, "Could not find domophone channel in bridge");
          }
        } else {
          app.log.warn({ bridgeId }, "Bridge has no channels yet");
        }
      } catch (bridgeError) {
        app.log.warn({ err: bridgeError, bridgeId }, "Failed to get bridge info to answer domophone channel");
      }
    } catch (error) {
      app.log.error({ err: error, channelId, bridgeId }, "CRITICAL: Failed to add outgoing channel to bridge - call will not connect");
      // Retry after a short delay
      try {
        await new Promise((r) => setTimeout(r, 500));
        await addChannelToBridge(bridgeId, channelId);
        app.log.info({ channelId, bridgeId }, "Outgoing channel added to bridge on retry");
      } catch (retryError) {
        app.log.error({ err: retryError, channelId, bridgeId }, "CRITICAL: Retry also failed - call connection failed");
      }
    }
    if (callIdForStatus) {
      if (connected) {
        const originateChannelIds = await listDialedChannels(callIdForStatus);
        for (const originateChannelId of originateChannelIds) {
          if (originateChannelId === channelId) continue;
          await hangupChannel(originateChannelId, app.log, "answered_elsewhere");
        }
        app.log.info(
          { callId: callIdForStatus, channelId },
          "Hung up other originate channels answered elsewhere"
        );
      } else {
        const callData = await getCall<CallData>(callIdForStatus);
        const panelChannelId = callData?.channelId;
        if (panelChannelId) {
          try {
            await continueInDialplan(panelChannelId, "from-domophone", "noanswer", 1);
          } catch (continueError) {
            app.log.warn(
              { err: continueError, channelId: panelChannelId },
              "Failed to continueInDialplan panel channel after bridge connect failure"
            );
          }
        }
        const originateChannelIds = await listDialedChannels(callIdForStatus);
        for (const originateChannelId of originateChannelIds) {
          await hangupChannel(originateChannelId, app.log);
        }
        await hangupChannel(channelId, app.log);
        app.log.error(
          { callId: callIdForStatus, channelId },
          "Emergency cleanup after failed call connect"
        );
      }
    }
  } else {
    app.log.error({ channelId, args: event.args }, "CRITICAL: No bridgeId in outgoing channel args");
  }
};
