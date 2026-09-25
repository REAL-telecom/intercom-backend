import { FastifyInstance } from "fastify";
import { getChannelVariable } from "../../ari";
import { parseDialContacts } from "../parsers";
import { removeTemporarySipEndpoint } from "./removal";
import { listTemporaryEndpoints } from "../../store/postgres";
import {
  getCall,
  getCallId,
  getDialStatus,
  getEndpoint,
  getOriginate,
  listDialedChannels,
} from "../../store/redis";

import type { CallData } from "../../types";

/**
 * Cleanup temporary endpoints if Redis TTL expired.
 * Redis cleans up data automatically by TTL; here we remove leftover Postgres rows and ARI objects.
 */
export const cleanupStaleEndpoints = async (app: FastifyInstance) => {
  try {
    const endpointIds = await listTemporaryEndpoints();
    for (const endpointId of endpointIds) {
      const session = await getEndpoint(endpointId);
      const callId = getCallId(endpointId);
      const callData = callId ? await getCall<CallData>(callId) : null;

      if (session && callData) {
        continue;
      }

      await removeTemporarySipEndpoint(endpointId, { reason: "ttl-expired" }, app);
    }
  } catch (error) {
    app.log.warn({ err: error }, "Cleanup: failed to cleanup stale endpoints");
  }
};

/**
 * Есть ли ещё контакты на учётке.
 *
 * true — кто-то ещё внутри. false — пусто. null — прочитать не удалось, канал уже нет.
 */
const hasRemainingContacts = async (endpointId: string): Promise<boolean | null> => {
  const callId = getCallId(endpointId);
  const channelIds: string[] = [];
  if (callId) {
    const callData = await getCall<CallData>(callId);
    if (callData?.channelId) {
      channelIds.push(callData.channelId);
    }
    channelIds.push(...(await listDialedChannels(callId)));
  }
  const pending = await getOriginate<{ channelId: string }>(endpointId);
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
 * Снять учётку, только если звонок уже кончился и контактов не осталось.
 *
 * Пока исход не захвачен, учётка нужна поздней регистрации. Если список
 * контактов прочитать нельзя, ждём таймер после конца звонка.
 */
export const removeEndpointIfNoContacts = async (endpointId: string, app: FastifyInstance) => {
  const callId = getCallId(endpointId);
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
  await removeTemporarySipEndpoint(endpointId, { callId, reason: "last-contact-removed" }, app);
};
