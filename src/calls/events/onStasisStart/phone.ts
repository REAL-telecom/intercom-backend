import { FastifyInstance } from "fastify";
import { env } from "../../../config";
import {
  addChannelToBridge,
  answerChannel,
  getBridge,
  hangupChannel,
} from "../../../ari";
import { finishCall } from "../../endpoints";
import { notifyCallOver } from "../../../push/notifyCallOver";
import {
  getCall,
  getDialStatus,
  listDialedChannels,
  setChannel,
  setDialStatus,
} from "../../../store/redis";

import type { Event } from "../../../ari";

/**
 * connectPhoneChannel — сажает ногу в мост и отвечает на канал панели.
 *
 * @param channelId идентификатор канала ноги
 * @param bridgeId идентификатор моста
 * @param callId идентификатор звонка для записи канала, если уже известен
 * @param app экземпляр Fastify
 * @returns истина, если панель отвечена
 */
async function connectPhoneChannel(
  channelId: string,
  bridgeId: string,
  callId: string | null,
  app: FastifyInstance
): Promise<boolean> {
  app.log.info({ channelId, bridgeId }, "Processing phone channel - adding to bridge");

  // Give the channel time to initialize
  await new Promise((r) => setTimeout(r, 200));

  await addChannelToBridge(bridgeId, channelId);
  app.log.info({ channelId, bridgeId }, "Outgoing channel successfully added to bridge");

  if (callId) {
    await setChannel(channelId, { callId }, env.callTokenTtlSec);
  }

  // Give the client channel time to fully initialize
  await new Promise((r) => setTimeout(r, 300));

  const bridgeInfo = await getBridge(bridgeId);
  app.log.info({ bridgeId, channels: bridgeInfo.channels, currentChannel: channelId }, "Bridge info retrieved");

  if (!bridgeInfo.channels || bridgeInfo.channels.length === 0) {
    app.log.warn({ bridgeId }, "Bridge has no channels yet");
    return false;
  }

  // Find the panel channel (not the current phone channel)
  const answeredPanelChannelId = bridgeInfo.channels.find((ch: string) => ch !== channelId);
  if (!answeredPanelChannelId) {
    app.log.warn({ bridgeId, channels: bridgeInfo.channels, currentChannel: channelId }, "Could not find panel channel in bridge");
    return false;
  }

  app.log.info({ panelChannelId: answeredPanelChannelId, bridgeId, allChannels: bridgeInfo.channels }, "Found panel channel in bridge, answering it");
  try {
    await answerChannel(answeredPanelChannelId);
    app.log.info({ panelChannelId: answeredPanelChannelId }, "CRITICAL: Answered panel channel - call should be fully connected now");
    return true;
  } catch (answerError) {
    app.log.warn({ err: answerError, panelChannelId: answeredPanelChannelId }, "Failed to answer panel channel, may already be answered");
    return false;
  }
}

export const onPhoneStasisStart = async (
  event: Event,
  channelId: string,
  eventArgs: unknown[],
  app: FastifyInstance
) => {
  const bridgeId = String(eventArgs[1] ?? "");
  const callIdForStatus = String(eventArgs[2] ?? "") || null;
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
      const acceptedCall = await getCall(callIdForStatus);
      if (acceptedCall) {
        await notifyCallOver(acceptedCall, "answered_elsewhere", app.log);
      } else {
        app.log.warn(
          { callId: callIdForStatus },
          "No call data for answered_elsewhere push, skipping push"
        );
      }
    } else {
      app.log.warn(
        { channelId, args: event.args },
        "Could not derive callId from phone channel args, skipping outcome claim"
      );
    }
    let connected = false;
    try {
      connected = await connectPhoneChannel(channelId, bridgeId, callIdForStatus, app);
    } catch (error) {
      app.log.error({ err: error, channelId, bridgeId }, "CRITICAL: Failed to add phone channel to bridge - call will not connect");
      // Retry after a short delay
      try {
        await new Promise((r) => setTimeout(r, 500));
        connected = await connectPhoneChannel(channelId, bridgeId, callIdForStatus, app);
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
        const call = await getCall(callIdForStatus);
        if (call) {
          await finishCall(call, "noanswer", "stasisEnd", app.log, app);
        }
        await hangupChannel(channelId, app.log);
        app.log.error(
          { callId: callIdForStatus, channelId },
          "Emergency cleanup after failed call connect"
        );
      }
    }
  } else {
    app.log.error({ channelId, args: event.args }, "CRITICAL: No bridgeId in phone channel args");
  }
};
