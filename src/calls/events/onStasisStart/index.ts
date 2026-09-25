import { FastifyInstance } from "fastify";
import { onDialedLeg } from "./dialedLeg";
import { onPanelStasisStart } from "./panel";

import type { AriEvent } from "../../../types";

export const onStasisStart = async (event: AriEvent, app: FastifyInstance) => {
  app.log.info({ fullEvent: JSON.stringify(event) }, "StasisStart event - full data");
  const channel = event.channel as {
    id?: string;
    name?: string;
    caller?: { number?: string; name?: string };
  };
  if (!channel.id) {
    app.log.warn({ event }, "StasisStart event without channel.id");
    return;
  }
  const channelId = channel.id;
  const eventArgs = Array.isArray((event as { args?: unknown[] }).args)
    ? ((event as { args?: unknown[] }).args as unknown[])
    : [];
  if (eventArgs[0] === "outgoing") {
    await onDialedLeg(event, channelId, eventArgs, app);
    return;
  }
  await onPanelStasisStart(channel, channelId, eventArgs, app);
};
