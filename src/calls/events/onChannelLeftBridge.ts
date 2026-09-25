import { FastifyInstance } from "fastify";
import { cleanupBridge } from "../bridges/cleanup";

import type { Event } from "../../ari/websocket";

export const onChannelLeftBridge = async (event: Event, app: FastifyInstance) => {
  const bridge = event.bridge as { id?: string; channels?: string[] };
  const bridgeId = bridge.id;
  if (!bridgeId) {
    return;
  }
  const remaining = Array.isArray(bridge.channels) ? bridge.channels : [];
  if (remaining.length > 1) {
    return;
  }
  await cleanupBridge(bridgeId, undefined, { source: "channelLeftBridge" }, app.log);
};
