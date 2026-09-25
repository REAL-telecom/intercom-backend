import { FastifyInstance } from "fastify";
import { env } from "../config";
import {
  getCall,
  setDialStatus,
  listDialedChannels,
  deletePanel,
  deleteOriginate,
} from "../store/redis";
import { hangupChannel, continueInDialplan } from "../ari";
import { cleanupBridge } from "../calls/bridges/cleanup";
import { notifyCallOver } from "../push/notifyCallOver";

import type { CallData } from "../types";

/**
 * Регистрирует маршруты звонка: завершение активного входящего
 * и уборку моста и каналов (`POST /calls/end`).
 */
export async function registerCallRoutes(app: FastifyInstance) {
  /**
   * Завершает входящий звонок: приложение зовёт, когда пользователь
   * нажал «отклонить» или звонок отклонён. Гасит канал панели
   * и удаляет мост.
   */
  app.post<{ Body: { callId: string } }>("/calls/end", async (request, reply) => {
    const callId = request.body?.callId?.trim();
    if (!callId) {
      return reply.code(400).send({ error: "callId required" });
    }
    const call = await getCall<CallData>(callId);
    if (!call?.channelId) {
      return reply.code(404).send({ error: "Call not found or already ended" });
    }
    const channelId = call.channelId;
    const claimed = await setDialStatus(callId, "rejected", env.callTokenTtlSec);
    request.log.info({ callId, claimed }, "calls/end: claimed rejected outcome");
    if (claimed) {
      await notifyCallOver(callId, call, "declined_elsewhere", request.log);
    }
    if (call.endpointId) {
      try {
        await deleteOriginate(call.endpointId);
        request.log.info(
          { callId, endpointId: call.endpointId },
          "calls/end: cleared pending originate"
        );
      } catch (err) {
        request.log.warn(
          { err, callId, endpointId: call.endpointId },
          "calls/end: failed to clear pending originate"
        );
      }
    }
    try {
      await continueInDialplan(channelId, "from-domophone", "busy", 1);
    } catch (err) {
      request.log.warn({ err, channelId, callId }, "continueInDialplan failed (intercom channel may already be down)");
    }
    const dialedChannelIds = await listDialedChannels(callId);
    for (const dialedChannelId of dialedChannelIds) {
      if ((await hangupChannel(dialedChannelId, request.log)) === "hungUp") {
        request.log.info(
          { callId, dialedChannelId },
          "calls/end: hung up dialed channel"
        );
      }
    }
    if (call.bridgeId) {
      await cleanupBridge(
        call.bridgeId,
        channelId,
        { callId, channelId, source: "callsEnd" },
        request.log
      );
    }
    if (call.domophoneEndpointId) {
      await deletePanel(call.domophoneEndpointId);
    }
    return reply.code(204).send();
  });
}
