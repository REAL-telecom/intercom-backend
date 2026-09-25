import { FastifyInstance } from "fastify";
import { cleanupBridge } from "../bridges/cleanup";

import type { AriEvent } from "../../types";

export const onChannelLeftBridge = async (event: AriEvent, app: FastifyInstance) => {
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
