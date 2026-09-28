import { FastifyInstance } from "fastify";
import { deleteEndpoint as deleteSipEndpoint, getChannelVariable } from "#ari";
import {
  clearCall,
  getCall,
  getDialStatus,
  getEndpoint,
  getOriginate,
  listDialedChannels,
} from "#store/redis";
import { parseDialContacts } from "../parsers";

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

export const deletePhoneEndpoint = async (
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

/**
 * Взводит удаление учётной записи, если снятие последнего контакта не придёт.
 *
 * Только после конца звонка. Повторный вызов не сдвигает срок.
 */
export const armEndpointRemoval = (endpointId: string, logCtx: Record<string, unknown>, app: FastifyInstance) => {
  if (endpointRemovalTimers.has(endpointId)) {
    return;
  }
  const timer = setTimeout(() => {
    endpointRemovalTimers.delete(endpointId);
    void deletePhoneEndpoint(endpointId, { ...logCtx, reason: "removal-grace" }, app);
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

/**
 * Есть ли ещё контакты на учётной записи.
 *
 * true — кто-то ещё внутри. false — пусто. null — прочитать не удалось, канал уже нет.
 */
const hasRemainingContacts = async (endpointId: string): Promise<boolean | null> => {
  const endpoint = await getEndpoint(endpointId);
  const callId = endpoint?.callId;
  const channelIds: string[] = [];
  if (callId) {
    const call = await getCall(callId);
    if (call?.channelId) {
      channelIds.push(call.channelId);
    }
    channelIds.push(...(await listDialedChannels(callId)));
  }
  const pending = await getOriginate(endpointId);
  if (pending?.channelId) {
    channelIds.push(pending.channelId);
  }
  const seen = new Set<string>();
  for (const channelId of channelIds) {
    if (seen.has(channelId)) {
      continue;
    }
    seen.add(channelId);
    try {
      const dialString = await getChannelVariable(
        channelId,
        `PJSIP_DIAL_CONTACTS(${endpointId})`
      );
      return parseDialContacts(dialString).length > 0;
    } catch {
      continue;
    }
  }
  return null;
};

/**
 * Снять учётную запись, только если звонок уже кончился и контактов не осталось.
 *
 * Пока исход не захвачен, учётная запись нужна поздней регистрации. Если список
 * контактов прочитать нельзя, ждём таймер после конца звонка.
 */
export const removeEndpointIfNoContacts = async (endpointId: string, app: FastifyInstance) => {
  const endpoint = await getEndpoint(endpointId);
  const callId = endpoint?.callId;
  const outcome = callId ? await getDialStatus(callId) : null;
  if (callId && outcome === null) {
    app.log.info({ endpointId, callId }, "ContactStatusChange: contact removed while call still pending");
    return;
  }
  const remaining = await hasRemainingContacts(endpointId);
  if (remaining === true) {
    app.log.info({ endpointId }, "ContactStatusChange: contact removed, others remain");
    return;
  }
  if (remaining === null) {
    app.log.info({ endpointId }, "ContactStatusChange: contact removed, remaining contacts unknown");
    return;
  }
  app.log.info({ endpointId, callId }, "ContactStatusChange: last contact gone, removing endpoint");
  await deletePhoneEndpoint(endpointId, { callId, reason: "last-contact-removed" }, app);
};
