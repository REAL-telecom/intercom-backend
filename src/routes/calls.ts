import { FastifyInstance } from "fastify";
import { env } from "#config";
import {
  getCall,
  setDialStatus,
} from "#store/redis";
import { finishCall } from "../calls/utils";
import { notifyCallOver } from "#push/notifyCallOver";

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
    const call = await getCall(callId);
    if (!call?.channelId) {
      return reply.code(404).send({ error: "Call not found or already ended" });
    }
    const claimed = await setDialStatus(call.id, "rejected", env.callTokenTtlSec);
    request.log.info({ callId: call.id, claimed }, "calls/end: claimed rejected outcome");
    if (claimed) {
      await notifyCallOver(call, "declined_elsewhere", request.log);
    }
    await finishCall(call, "busy", "callsEnd", request.log, app);
    return reply.code(204).send();
  });
}
