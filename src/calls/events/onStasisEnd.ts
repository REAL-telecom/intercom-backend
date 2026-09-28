import { FastifyInstance } from "fastify";
import { env } from "#config";
import { finishCall } from "../utils";
import { notifyCallOver } from "#push/notifyCallOver";
import {
  getCall,
  getChannel,
  getDialStatus,
  setDialStatus,
  type Call,
} from "#store/redis";

import type { Event } from "#ari";

export const onStasisEnd = async (event: Event, app: FastifyInstance) => {
  const channel = event.channel as { id?: string };
  if (!channel.id) return;
  const channelId = channel.id;

  app.log.info({ channelId }, "StasisEnd - channel terminated, cleaning up bridge");

  const channelRecord = await getChannel(channelId);
  let call: Call | null = null;
  if (channelRecord?.callId) {
    call = await getCall(channelRecord.callId);
  }
  if (!call?.bridgeId) {
    app.log.debug({ channelId }, "No bridgeId in call data, skipping bridge cleanup");
  }

  if (call) {
    const claimed = await setDialStatus(call.id, "canceled", env.callTokenTtlSec);
    if (claimed) {
      await notifyCallOver(call, "caller_hung_up", app.log);
    } else {
      const outcome = await getDialStatus(call.id);
      if (outcome === "accepted") {
        await notifyCallOver(call, "ended", app.log);
      }
    }
    await finishCall(call, "gone", "stasisEnd", app.log, app);
  }

  // Redis will cleanup session data automatically by TTL
};
