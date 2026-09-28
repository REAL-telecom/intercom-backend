import { FastifyInstance } from "fastify";
import { cleanupOtpChannel } from "../../otp/dialer";
import { deleteOriginate, getCall, getChannel } from "#store/redis";

import type { Event } from "#ari";

export const onChannelDestroyed = async (event: Event, app: FastifyInstance) => {
  const channel = event.channel as { id?: string };
  if (!channel.id) return;
  const channelId = channel.id;

  try {
    const isOtpChannel = await cleanupOtpChannel(app, channelId);
    if (isOtpChannel) {
      return;
    }

    const channelRecord = await getChannel(channelId);
    const callId = channelRecord?.callId;
    if (!callId) return;

    const call = await getCall(callId);
    const phoneId = call?.phoneId;
    if (!phoneId) return;

    await deleteOriginate(phoneId);
    app.log.info({ channelId, callId: call?.id, phoneId }, "ChannelDestroyed: cleared pending originate");
  } catch (error) {
    app.log.warn({ err: error, channelId }, "ChannelDestroyed: failed to clear pending originate");
  }
  return;
};
