import { FastifyInstance } from "fastify";
import { deleteEndpoint } from "../../ari";
import { clearCall, getCallId } from "../../store/redis";

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
    await deleteEndpoint(endpointId);
    const callId =
      (typeof logCtx.callId === "string" && logCtx.callId) || getCallId(endpointId);
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
