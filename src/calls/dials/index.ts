import { FastifyInstance } from "fastify";
import { env } from "#config";
import {
  getChannel,
  getChannelVariable,
  hangupChannel,
  createChannelInStasis,
  AriRequestError,
  AriTransportError,
} from "#ari";
import { parseDialContacts } from "../parsers";
import { listPhoneEndpoints } from "#store/postgres";
import {
  addDialedChannel,
  addDialedContact,
  deleteOriginate,
  getCall,
  getChannel as getChannelRecord,
  getDialStatus,
  getOriginate,
  listDialedChannels,
  removeDialedContact,
} from "#store/redis";

export type DialPendingSource = "event" | "poll";

/**
 * Дозвонить на контакты временной учётной записи, если дозвон ещё ждёт.
 *
 * Контакты читает с канала панели через PJSIP_DIAL_CONTACTS, чтобы строка
 * приглашения не отличалась от опроса. Цикл и событие зовут одну функцию.
 *
 * @param endpointId — id временного эндпоинта
 * @param source — откуда вызвали, пишется в лог
 * @param app — экземпляр Fastify, источник лога
 */
export const dialPendingContacts = async (endpointId: string, source: DialPendingSource, app: FastifyInstance) => {
  const pending = await getOriginate(endpointId);
  if (!pending) {
    return;
  }

  const pendingChannelSession = await getChannelRecord(pending.channelId);
  const pendingCallId = pendingChannelSession?.callId;
  if (!pendingCallId) {
    await deleteOriginate(endpointId);
    app.log.info({ endpointId, channelId: pending.channelId, source }, "Dropped stale pending originate: no callId for channel");
    return;
  }

  const pendingCall = await getCall(pendingCallId);
  const pendingOutcome = await getDialStatus(pendingCallId);
  if (
    !pendingCall ||
    pendingOutcome !== null ||
    pendingCall.phoneId !== endpointId
  ) {
    await deleteOriginate(endpointId);
    app.log.info(
      {
        endpointId,
        callId: pendingCall?.id ?? pendingCallId,
        outcome: pendingOutcome,
        actualPhoneId: pendingCall?.phoneId,
        source,
      },
      "Dropped stale pending originate: call is no longer pending"
    );
    return;
  }

  try {
    const dialString = await getChannelVariable(
      pending.channelId,
      `PJSIP_DIAL_CONTACTS(${endpointId})`
    );
    const dialContacts = parseDialContacts(dialString);
    if (dialContacts.length === 0) {
      app.log.debug(
        { endpointId, channelId: pending.channelId, source },
        "No PJSIP contacts yet, keeping pending originate"
      );
      return;
    }

    const appArgs = `phone,${pending.bridgeId}`;
    for (const dialContact of dialContacts) {
      if ((await getDialStatus(pendingCallId)) !== null) {
        break;
      }
      const claimedContact = await addDialedContact(
        pendingCallId,
        dialContact,
        env.ringTimeoutSec
      );
      if (!claimedContact) {
        continue;
      }
      try {
        app.log.info(
          { endpointId, bridgeId: pending.bridgeId, contact: dialContact, source, time: Date.now() },
          "ATTEMPTING to originate call to endpoint"
        );
        const originated = await createChannelInStasis(dialContact, appArgs);
        await addDialedChannel(pendingCallId, originated.id, env.callTokenTtlSec);
        app.log.info(
          {
            endpointId,
            bridgeId: pending.bridgeId,
            contact: dialContact,
            originateChannelId: originated.id,
            source,
            time: Date.now(),
          },
          source === "event"
            ? "SUCCESS: Originated call from contact status change"
            : "SUCCESS: Originated call from periodic check"
        );
      } catch (error) {
        await removeDialedContact(pendingCallId, dialContact);
        app.log.warn(
          {
            err: error,
            endpointId,
            contact: dialContact,
            source,
          },
          "FAILED: Could not originate call to contact"
        );
      }
    }

    let panelChannelAlive = true;
    try {
      await getChannel(pending.channelId);
    } catch (error) {
      if (error instanceof AriRequestError && error.status === 404) {
        panelChannelAlive = false;
      } else {
        const isTimeout = error instanceof AriTransportError && error.isTimeout;
        app.log.warn(
          { err: error, endpointId, channelId: pending.channelId, isTimeout, source },
          "Could not read panel channel, not treating as gone"
        );
      }
    }
    const outcomeAfterOriginate = await getDialStatus(pendingCallId);
    if (outcomeAfterOriginate === "accepted") {
      // Do not hang up here: the winner hangs up other legs. The outcome
      // check before originate guarantees every created leg is in the set
      // before the winner enumerates it.
      await deleteOriginate(endpointId);
      return;
    }
    if (!panelChannelAlive || outcomeAfterOriginate !== null) {
      const originateChannelIds = await listDialedChannels(pendingCallId);
      for (const originatedId of originateChannelIds) {
        await hangupChannel(originatedId, app.log);
      }
      await deleteOriginate(endpointId);
    }
  } catch (error) {
    const err = error as Error & { code?: string };
    app.log.warn(
      {
        err: error,
        endpointId,
        bridgeId: pending.bridgeId,
        source,
        time: Date.now(),
        errorMessage: err?.message,
        errorCode: err?.code,
      },
      "FAILED: Could not originate call"
    );
  }
};

/**
 * Retry originate until PJSIP has a contact on the temp endpoint.
 * Do not wait for ARI EndpointStateChange/online: realtime endpoints created
 * at runtime do not update ARI device state.
 * Each pass originates a separate INVITE per PJSIP contact; pending is kept
 * while the call is still ringing so devices that register later are dialed.
 * Pending is deleted once the call is answered, rejected, canceled, timed out, or the panel channel is gone.
 */
export const checkPendingOriginate = async (app: FastifyInstance) => {
  try {
    const endpointIds = await listPhoneEndpoints();
    for (const endpointId of endpointIds) {
      await dialPendingContacts(endpointId, "poll", app);
    }
  } catch (error) {
    app.log.warn({ err: error }, "Failed to check pending originate");
  }
};
