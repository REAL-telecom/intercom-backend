import { FastifyInstance } from "fastify";
import type { FastifyBaseLogger } from "fastify";
import { continueInDialplan, hangupChannel } from "#ari";
import { cleanupBridge, type CleanupBridgeContext } from "../bridges";
import { armEndpointRemoval } from "../endpoints/endpoint";
import { deleteOriginate, listDialedChannels, releaseEndpoint, type Call } from "#store/redis";

export type PanelExit = "busy" | "noanswer" | "gone";

/**
 * Завершает медиа звонка и ставит учётку телефона в очередь на снятие.
 *
 * Замок панели снимается первым. call: остаётся до удаления учётки через ARI,
 * чтобы дворник не принял её за сироту.
 *
 * @param call — запись звонка
 * @param panelExit — куда уходит канал панели: busy, noanswer или уже вышел
 * @param source — откуда пришла уборка, для лога моста
 * @param logger — логгер
 * @param app — экземпляр Fastify для таймера снятия учётки
 */
export async function finishCall(
  call: Call,
  panelExit: PanelExit,
  source: CleanupBridgeContext["source"],
  logger: FastifyBaseLogger,
  app: FastifyInstance
): Promise<void> {
  if (call.panelId) {
    await releaseEndpoint(call.panelId, call.id);
  }
  const dialedChannelIds = await listDialedChannels(call.id);
  for (const dialedChannelId of dialedChannelIds) {
    await hangupChannel(dialedChannelId, logger);
  }
  if (call.channelId && panelExit !== "gone") {
    try {
      await continueInDialplan(call.channelId, "panel", panelExit, 1);
    } catch (error) {
      logger.warn(
        { err: error, channelId: call.channelId, callId: call.id },
        "finishCall: failed to return panel channel to dialplan"
      );
    }
  }
  if (call.bridgeId) {
    // "gone" — панель уже ушла или ушла нога: канал панели не щадить, иначе он зависнет в Stasis
    const skipChannelId = panelExit === "gone" ? undefined : call.channelId;
    await cleanupBridge(
      call.bridgeId,
      skipChannelId,
      {
        callId: call.id,
        ...(call.channelId ? { channelId: call.channelId } : {}),
        source,
      },
      logger
    );
  }
  if (call.phoneId) {
    try {
      await deleteOriginate(call.phoneId);
    } catch (error) {
      logger.warn({ err: error, callId: call.id, phoneId: call.phoneId }, "finishCall: failed to clear originate");
    }
    armEndpointRemoval(call.phoneId, { callId: call.id, source }, app);
  }
}
