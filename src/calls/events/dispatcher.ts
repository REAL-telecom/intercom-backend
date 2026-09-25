import { FastifyInstance } from "fastify";
import { onChannelDestroyed } from "./onChannelDestroyed";
import { onChannelLeftBridge } from "./onChannelLeftBridge";
import { onContactStatusChange } from "./onContactStatusChange";
import { onStasisEnd } from "./onStasisEnd";
import { onStasisStart } from "./onStasisStart";

import type { Event } from "../../ari/websocket";

/**
 * Обрабатывает событие ARI.
 *
 * Реагирует на ContactStatusChange, ChannelDestroyed, StasisStart, StasisEnd, ChannelLeftBridge.
 *
 * @param event — событие ARI
 * @param app — экземпляр Fastify, источник лога
 */
export async function handleAriEvent(event: Event, app: FastifyInstance): Promise<void> {
  // Log all events for debugging
  app.log.info({ eventType: event.type, fullEvent: JSON.stringify(event, null, 2) }, "ARI event received");

  if (event.type === "ContactStatusChange") {
    await onContactStatusChange(event, app);
    return;
  }

  if (event.type === "ChannelDestroyed" && typeof event.channel === "object" && event.channel) {
    await onChannelDestroyed(event, app);
    return;
  }

  if (event.type === "StasisStart" && typeof event.channel === "object" && event.channel) {
    await onStasisStart(event, app);
    return;
  }

  if (event.type === "StasisEnd" && typeof event.channel === "object" && event.channel) {
    await onStasisEnd(event, app);
    return;
  }

  if (event.type === "ChannelLeftBridge" && typeof event.bridge === "object" && event.bridge) {
    await onChannelLeftBridge(event, app);
  }
}
