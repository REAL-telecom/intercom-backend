import { FastifyInstance } from "fastify";
import { cleanupOtpChannel } from "../../otp/dialer";
import { deleteOriginate, getCall, getChannel } from "../../store/redis";

import type { AriEvent, CallData, ChannelSession } from "../../types";

export const onChannelDestroyed = async (event: AriEvent, app: FastifyInstance) => {
  const channel = event.channel as { id?: string };
  if (!channel.id) return;
  const channelId = channel.id;

  try {
    const isOtpChannel = await cleanupOtpChannel(app, channelId);
    if (isOtpChannel) {
      return;
    }

    const channelSession = await getChannel<ChannelSession>(channelId);
    const callId = channelSession?.callId;
    if (!callId) return;

    const callData = await getCall<CallData>(callId);
    const endpointId = callData?.endpointId;
    if (!endpointId) return;

    await deleteOriginate(endpointId);
    app.log.info({ channelId, callId, endpointId }, "ChannelDestroyed: cleared pending originate");
  } catch (error) {
    app.log.warn({ err: error, channelId }, "ChannelDestroyed: failed to clear pending originate");
  }
  return;
};
