import { FastifyInstance } from "fastify";
import type { FastifyBaseLogger } from "fastify";
import { continueInDialplan, deleteEndpoint as deleteSipEndpoint, hangupChannel } from "../../ari";
import { cleanupBridge, type CleanupBridgeContext } from "../bridges/cleanup";
import {
  clearCall,
  deleteOriginate,
  getEndpoint,
  listDialedChannels,
  releaseEndpoint,
  type Call,
} from "../../store/redis";

/**
 * Сколько ждать снятия последнего контакта после конца звонка, миллисекунды.
 *
 * Раньше конца звонка не взводить: accepted — начало разговора, не отбой.
 */
const ENDPOINT_REMOVAL_GRACE_MS = 15_000;

const endpointRemovalTimers = new Map<string, ReturnType<typeof setTimeout>>();

const cancelEndpointRemoval = (endpointId: string) => {
  const timer = endpointRemovalTimers.get(endpointId);
  if (!timer) {
    return;
  }
  clearTimeout(timer);
  endpointRemovalTimers.delete(endpointId);
};

export const removeTemporarySipEndpoint = async (
  endpointId: string,
  logCtx: Record<string, unknown>,
  app: FastifyInstance
) => {
  cancelEndpointRemoval(endpointId);
  try {
    await deleteSipEndpoint(endpointId);
    const endpoint = await getEndpoint(endpointId);
    const callId =
      (typeof logCtx.callId === "string" && logCtx.callId) || endpoint?.callId;
    if (callId) {
      try {
        await clearCall(callId, endpointId);
      } catch (memoError) {
        app.log.warn(
          { err: memoError, endpointId, callId, ...logCtx },
          "Failed to clear call data after endpoint delete"
        );
      }
    }
    app.log.debug({ endpointId, ...logCtx }, "Temporary SIP endpoint removed");
  } catch (err) {
    app.log.warn(
      { err, endpointId, ...logCtx },
      "Failed to delete temporary SIP endpoint from ARI"
    );
  }
};

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

/**
 * Взводит удаление учётки, если снятие последнего контакта не придёт.
 *
 * Только после конца звонка. Повторный вызов не сдвигает срок.
 */
export const armEndpointRemoval = (endpointId: string, logCtx: Record<string, unknown>, app: FastifyInstance) => {
  if (endpointRemovalTimers.has(endpointId)) {
    return;
  }
  const timer = setTimeout(() => {
    endpointRemovalTimers.delete(endpointId);
    void removeTemporarySipEndpoint(endpointId, { ...logCtx, reason: "removal-grace" }, app);
  }, ENDPOINT_REMOVAL_GRACE_MS);
  endpointRemovalTimers.set(endpointId, timer);
  app.log.info({ endpointId, graceMs: ENDPOINT_REMOVAL_GRACE_MS, ...logCtx }, "Armed endpoint removal grace");
};

/**
 * Снимает все взведённые таймеры удаления учёток.
 *
 * Вызывается при остановке процесса, чтобы таймер не сработал после закрытия.
 */
export function cancelAllEndpointRemovals(): void {
  for (const endpointId of [...endpointRemovalTimers.keys()]) {
    cancelEndpointRemoval(endpointId);
  }
}
