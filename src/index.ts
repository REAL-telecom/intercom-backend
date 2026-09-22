import Fastify from "fastify";
import sensible from "@fastify/sensible";
import fs from "fs";
import { env } from "./config";
import { createDatabaseSchema, seedEndpointTemplates } from "./store/postgres";
import { registerAuthRoutes } from "./routes/auth";
import { registerPushRoutes } from "./routes/push";
import { registerCallRoutes } from "./routes/calls";
import { cleanupBridge } from "./calls/cleanup";
import { cleanupOtpChannel, startOtpDialer } from "./otp/dialer";
import {
  connectAriEvents,
  answerChannel,
  createBridge,
  addChannelToBridge,
  hangupChannel,
  originateCall,
  getChannel,
  listChannels,
  getChannelVariable,
  getBridge,
  createEndpoint,
  deleteEndpoint,
  continueInDialplan,
  AriTransportError,
} from "./ari";
import { AriRequestError } from "./ari/request";
import {
  listPushTokens,
  removePushTokens,
  getAddress,
  formatAddress,
  getPanel,
  getUser,
  listTempEndpoints,
} from "./store/postgres";
import {
  setCallData,
  setChannelSession,
  setEndpointSession,
  getEndpointSession,
  getCallData,
  setDialStatus,
  getDialStatus,
  addDialedChannel,
  listDialedChannels,
  addDialedContact,
  removeDialedContact,
  getCallId,
  setPendingOriginate,
  getPendingOriginate,
  deletePendingOriginate,
  getChannelSession,
  getCallingPanel,
  setCallingPanel,
  deleteCallingPanel,
  clearCallData,
} from "./store/redis";
import { sendFcmPush } from "./push/fcm";
import { sendApnsVoipPush } from "./push/apns";
import { callOutcomeToEndedReason, notifyCallOver } from "./push/notifyCallOver";
import crypto from "crypto";

import type { AriEvent, ChannelSession, CallData } from "./types";

// Пути к сертификатам Let's Encrypt:
//  - fullchain.pem — цепочка публичных ключей,
//  - privkey.pem — приватный ключ домена.
// Если файлов нет, сервис работает по HTTP.
const certPath = `/etc/letsencrypt/live/${env.serverDomain}/fullchain.pem`;
const keyPath = `/etc/letsencrypt/live/${env.serverDomain}/privkey.pem`;
const hasCertificates = fs.existsSync(certPath) && fs.existsSync(keyPath);

// Опции HTTPS для Fastify. Сертификаты читаются синхронно при старте.
// Если чтение упало, например файл битый или нет доступа, работаем по HTTP:
// сервис должен подняться, а не уйти в цикл перезапуска.
// Здесь console.warn, а не app.log: логгер Fastify ещё не создан.
let httpsOptions: { cert: Buffer; key: Buffer } | undefined;
if (hasCertificates) {
  try {
    httpsOptions = {
      cert: fs.readFileSync(certPath),
      key: fs.readFileSync(keyPath),
    };
  } catch (error) {
    console.warn("Failed to read SSL certificates, falling back to HTTP", error);
  }
}

// Создаёт экземпляр Fastify. Это конструктор сервера, а не запуск:
// порт начнёт слушаться только на app.listen. До этого на экземпляр
// навешиваются плагины и маршруты.
//
// Опции:
//  - logger — встроенный логгер, доступен как app.log
//  - https — добавляется, только если сертификаты прочитаны. Иначе Fastify работает по HTTP.
const app = Fastify({
  logger: { level: env.logLevel },
  ...(httpsOptions ? { https: httpsOptions } : {}),
});

// Подключает плагин @fastify/sensible. Он добавляет хелперы HTTP-ответов,
// например app.httpErrors.badRequest и reply.notFound. Без него этих методов нет.
app.register(sensible);

const INCOMING_MAX_CONTACTS = 8;

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

const removeTemporarySipEndpoint = async (
  endpointId: string,
  logCtx: Record<string, unknown>
) => {
  cancelEndpointRemoval(endpointId);
  try {
    await deleteEndpoint(endpointId);
    const callId =
      (typeof logCtx.callId === "string" && logCtx.callId) || getCallId(endpointId);
    if (callId) {
      try {
        await clearCallData(callId, endpointId);
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
const armEndpointRemoval = (endpointId: string, logCtx: Record<string, unknown>) => {
  if (endpointRemovalTimers.has(endpointId)) {
    return;
  }
  const timer = setTimeout(() => {
    endpointRemovalTimers.delete(endpointId);
    void removeTemporarySipEndpoint(endpointId, { ...logCtx, reason: "removal-grace" });
  }, ENDPOINT_REMOVAL_GRACE_MS);
  endpointRemovalTimers.set(endpointId, timer);
  app.log.info({ endpointId, graceMs: ENDPOINT_REMOVAL_GRACE_MS, ...logCtx }, "Armed endpoint removal grace");
};

/**
 * Обрабатывает событие ARI.
 *
 * Реагирует на ContactStatusChange, ChannelDestroyed, StasisStart, StasisEnd, ChannelLeftBridge.
 *
 * @param event — событие ARI
 */
async function handleAriEvent(event: AriEvent): Promise<void> {
  // Log all events for debugging
  app.log.info({ eventType: event.type, fullEvent: JSON.stringify(event, null, 2) }, "ARI event received");

  if (event.type === "ContactStatusChange") {
    const appearedEndpointId = readAppearedContactAor(event);
    if (appearedEndpointId) {
      try {
        await dialPendingContacts(appearedEndpointId, "event");
      } catch (error) {
        app.log.warn({ err: error, endpointId: appearedEndpointId }, "ContactStatusChange: failed to originate");
      }
      return;
    }
    const removedEndpointId = readRemovedContactAor(event);
    if (removedEndpointId) {
      try {
        await removeEndpointIfNoContacts(removedEndpointId);
      } catch (error) {
        app.log.warn({ err: error, endpointId: removedEndpointId }, "ContactStatusChange: failed to remove endpoint");
      }
    }
    return;
  }

  if (event.type === "ChannelDestroyed" && typeof event.channel === "object" && event.channel) {
    const channel = event.channel as { id?: string };
    if (!channel.id) return;
    const channelId = channel.id;

    try {
      const isOtpChannel = await cleanupOtpChannel(app, channelId);
      if (isOtpChannel) {
        return;
      }

      const channelSession = await getChannelSession<ChannelSession>(channelId);
      const callId = channelSession?.callId;
      if (!callId) return;

      const callData = await getCallData<CallData>(callId);
      const endpointId = callData?.endpointId;
      if (!endpointId) return;

      await deletePendingOriginate(endpointId);
      app.log.info({ channelId, callId, endpointId }, "ChannelDestroyed: cleared pending originate");
    } catch (error) {
      app.log.warn({ err: error, channelId }, "ChannelDestroyed: failed to clear pending originate");
    }
    return;
  }

  if (event.type === "StasisStart" && typeof event.channel === "object" && event.channel) {
    app.log.info({ fullEvent: JSON.stringify(event) }, "StasisStart event - full data");
    const channel = event.channel as {
      id?: string;
      name?: string;
      caller?: { number?: string; name?: string };
    };
    if (!channel.id) {
      app.log.warn({ event }, "StasisStart event without channel.id");
      return;
    }
    const channelId = channel.id;
    const eventArgs = Array.isArray((event as { args?: unknown[] }).args)
      ? ((event as { args?: unknown[] }).args as unknown[])
      : [];
    if (eventArgs[0] === "outgoing") {
      const bridgeId = String(eventArgs[1] ?? "");
      const endpointIdFromArgs = String(eventArgs[2] ?? "");
      const callIdForStatus = endpointIdFromArgs ? getCallId(endpointIdFromArgs) : null;
      if (bridgeId) {
        if (callIdForStatus) {
          const claimed = await setDialStatus(callIdForStatus, "accepted", env.callTokenTtlSec);
          if (!claimed) {
            const outcome = await getDialStatus(callIdForStatus);
            if (outcome === "accepted") {
              await hangupChannel(channelId, app.log, "answered_elsewhere");
            } else {
              await hangupChannel(channelId, app.log, "normal");
            }
            app.log.info(
              { channelId, callId: callIdForStatus, outcome },
              "Outgoing channel lost race or call already ended"
            );
            return;
          }
          app.log.info({ callId: callIdForStatus }, "Call marked as accepted (timeout will not hang up)");
          const acceptedCallData = await getCallData<CallData>(callIdForStatus);
          if (acceptedCallData) {
            await notifyCallOver(
              callIdForStatus,
              acceptedCallData,
              "answered_elsewhere",
              app.log
            );
          } else {
            app.log.warn(
              { callId: callIdForStatus },
              "No call data for answered_elsewhere push, skipping push"
            );
          }
        } else {
          app.log.warn(
            { channelId, args: event.args },
            "Could not derive callId from outgoing channel args, skipping outcome claim"
          );
        }
        let connected = false;
        try {
          app.log.info({ channelId, bridgeId }, "Processing outgoing channel - adding to bridge");
          
          // Give the channel time to initialize
          await new Promise((r) => setTimeout(r, 200));
          
          // Add the channel to the bridge
          await addChannelToBridge(bridgeId, channelId);
          app.log.info({ channelId, bridgeId }, "Outgoing channel successfully added to bridge");
          
          // Store bridgeId in outgoing channel session for cleanup
          await setChannelSession(
            channelId,
            { bridgeId },
            env.callTokenTtlSec
          );
          
          // Now we need to answer the domophone channel
          // Get bridge info to find the domophone channel
          try {
            // Give the client channel time to fully initialize
            await new Promise((r) => setTimeout(r, 300));
            
            const bridgeInfo = await getBridge(bridgeId);
            app.log.info({ bridgeId, channels: bridgeInfo.channels, currentChannel: channelId }, "Bridge info retrieved");
            
            if (bridgeInfo.channels && bridgeInfo.channels.length > 0) {
              // Find the domophone channel (not the current outgoing channel)
              const domophoneChannelId = bridgeInfo.channels.find((ch: string) => ch !== channelId);
              if (domophoneChannelId) {
                app.log.info({ domophoneChannelId, bridgeId, allChannels: bridgeInfo.channels }, "Found domophone channel in bridge, answering it");
                try {
                  await answerChannel(domophoneChannelId);
                  connected = true;
                  app.log.info({ domophoneChannelId }, "CRITICAL: Answered domophone channel - call should be fully connected now");
                } catch (answerError) {
                  app.log.warn({ err: answerError, domophoneChannelId }, "Failed to answer domophone channel, may already be answered");
                }
              } else {
                app.log.warn({ bridgeId, channels: bridgeInfo.channels, currentChannel: channelId }, "Could not find domophone channel in bridge");
              }
            } else {
              app.log.warn({ bridgeId }, "Bridge has no channels yet");
            }
          } catch (bridgeError) {
            app.log.warn({ err: bridgeError, bridgeId }, "Failed to get bridge info to answer domophone channel");
          }
        } catch (error) {
          app.log.error({ err: error, channelId, bridgeId }, "CRITICAL: Failed to add outgoing channel to bridge - call will not connect");
          // Retry after a short delay
          try {
            await new Promise((r) => setTimeout(r, 500));
            await addChannelToBridge(bridgeId, channelId);
            app.log.info({ channelId, bridgeId }, "Outgoing channel added to bridge on retry");
          } catch (retryError) {
            app.log.error({ err: retryError, channelId, bridgeId }, "CRITICAL: Retry also failed - call connection failed");
          }
        }
        if (callIdForStatus) {
          if (connected) {
            const originateChannelIds = await listDialedChannels(callIdForStatus);
            for (const originateChannelId of originateChannelIds) {
              if (originateChannelId === channelId) continue;
              await hangupChannel(originateChannelId, app.log, "answered_elsewhere");
            }
            app.log.info(
              { callId: callIdForStatus, channelId },
              "Hung up other originate channels answered elsewhere"
            );
          } else {
            const callData = await getCallData<CallData>(callIdForStatus);
            const panelChannelId = callData?.channelId;
            if (panelChannelId) {
              try {
                await continueInDialplan(panelChannelId, "from-domophone", "noanswer", 1);
              } catch (continueError) {
                app.log.warn(
                  { err: continueError, channelId: panelChannelId },
                  "Failed to continueInDialplan panel channel after bridge connect failure"
                );
              }
            }
            const originateChannelIds = await listDialedChannels(callIdForStatus);
            for (const originateChannelId of originateChannelIds) {
              await hangupChannel(originateChannelId, app.log);
            }
            await hangupChannel(channelId, app.log);
            app.log.error(
              { callId: callIdForStatus, channelId },
              "Emergency cleanup after failed call connect"
            );
          }
        }
      } else {
        app.log.error({ channelId, args: event.args }, "CRITICAL: No bridgeId in outgoing channel args");
      }
      return;
    }

    try {
      // Do not answer immediately - we will answer after the client channel answers
      // This is needed for proper connection setup
      app.log.info({ channelId }, "Incoming domophone channel received, will answer after client connects");

      // PJSIP channel name is like "PJSIP/endpoint_id-<uniq>"; extract endpoint_id for address lookup
      const namePart = channel.name?.split("/")[1];
      const domophoneEndpointId = namePart ? namePart.split("-")[0] : null;
      const callId = crypto.randomUUID();
      const panelIpFromArgs = typeof eventArgs[0] === "string" ? eventArgs[0].trim() : "";
      const apartmentFromArgs = typeof eventArgs[1] === "string" ? eventArgs[1].trim() : "";
      const apartment = /^\d+$/.test(apartmentFromArgs) ? apartmentFromArgs : null;
      const panelIp = panelIpFromArgs || null;
      let address = "";
      let userId: number | null = null;
      if (!panelIp) {
        app.log.warn({ callId, channelId, args: eventArgs }, "Panel IP not found in Stasis args");
      } else if (!apartment) {
        app.log.warn({ callId, channelId, panelIp, args: eventArgs }, "Apartment not found in incoming call payload");
      } else {
        const panel = await getPanel(panelIp);
        if (!panel) {
          app.log.warn({ callId, panelIp }, "Panel is not configured in DB");
        } else {
          const addressRecord = await getAddress(panel.address_id);
          if (addressRecord) {
            address = formatAddress(addressRecord);
          }
          const user = await getUser(panel.address_id, apartment);
          if (!user) {
            app.log.warn({ callId, panelIp, addressId: panel.address_id, apartment }, "User not found by address/apartment");
          } else {
            userId = user.id;
          }
        }
      }

      if (userId === null) {
        app.log.info({ callId, channelId, panelIp, apartment }, "No subscriber for incoming call, sending panel to invalid");
        try {
          await continueInDialplan(channelId, "from-domophone", "invalid", 1);
          app.log.info({ channelId, callId }, "Panel channel sent to invalid");
        } catch (continueError) {
          app.log.warn(
            { err: continueError, channelId, callId },
            "Failed to continueInDialplan panel channel to invalid"
          );
          await hangupChannel(channelId, app.log);
        }
        return;
      }

      if (domophoneEndpointId) {
        const claimed = await setCallingPanel(
          domophoneEndpointId,
          callId,
          env.callTokenTtlSec
        );
        if (!claimed) {
          const existingCallId = await getCallingPanel(domophoneEndpointId);
          app.log.info(
            { panelId: domophoneEndpointId, existingCallId, channelId },
            "Ignoring duplicate incoming from same panel"
          );
          const hangupResult = await hangupChannel(channelId, app.log);
          if (hangupResult === "hungUp") {
            app.log.info({ channelId }, "Hung up duplicate channel so it does not hang in Stasis");
          } else if (hangupResult === "failed") {
            app.log.warn({ channelId }, "Failed to hang up duplicate channel");
          }
          return;
        }
      }
      const endpointId = `inc_${callId}`;
      const sipUsername = endpointId;
      const sipPassword = crypto.randomBytes(8).toString("hex");

      app.log.info({ endpointId, sipUsername, context: "intercom", maxContacts: INCOMING_MAX_CONTACTS }, "Creating temporary SIP endpoint");
      await createEndpoint({
        context: "intercom",
        id: endpointId,
        maxContacts: INCOMING_MAX_CONTACTS,
        password: sipPassword,
        username: sipUsername,
      });
      app.log.info({ endpointId }, "Temporary SIP endpoint created");
      await setEndpointSession(endpointId, { type: "incoming" }, env.callTokenTtlSec);

      // Bridge and originate: same logic as previously in GET /calls/credentials.
      // bridgeId is set only after full setup so ring push and ring timeout never run on a failed room.
      let bridgeId: string | undefined;
      let createdBridgeId: string | undefined;
      try {
        app.log.info({ callId, channelId, endpointId }, "STEP 1: Creating bridge and setting up originate");
        const bridge = await createBridge();
        createdBridgeId = bridge.id;
        app.log.info({ bridgeId: bridge.id, channelId }, "STEP 2: Bridge created, adding incoming domophone channel");
        await new Promise((r) => setTimeout(r, 300));
        await addChannelToBridge(bridge.id, channelId);
        app.log.info({ bridgeId: bridge.id, channelId }, "STEP 3: Incoming domophone channel added to bridge");

        // Single root key: full call data in call:${callId}, channel session only points to callId
        await setCallData(
          callId,
          {
            channelId,
            endpointId,
            bridgeId: bridge.id,
            userId: userId ?? undefined,
            apartment: apartment ?? undefined,
            panelIp: panelIp ?? undefined,
            address,
            ...(domophoneEndpointId ? { domophoneEndpointId } : {}),
            credentials: {
              sipCredentials: {
                username: sipUsername,
                password: sipPassword,
                domain: env.serverDomain,
              },
            },
          },
          env.callTokenTtlSec
        );
        app.log.info({ callId, channelId, endpointId, ttlSec: env.callTokenTtlSec }, "Call data stored");
        await setChannelSession(channelId, { callId }, env.callTokenTtlSec);

        await setPendingOriginate(endpointId, { bridgeId: bridge.id, channelId }, env.ringTimeoutSec);
        app.log.info({ endpointId, bridgeId: bridge.id }, "STEP 4: Pending originate stored, waiting for endpoint registration.");
        bridgeId = bridge.id;
      } catch (error) {
        app.log.error({ err: error, callId, channelId, endpointId }, "CRITICAL: Failed to setup bridge/originate - call will not connect");
        if (domophoneEndpointId) {
          try {
            await deleteCallingPanel(domophoneEndpointId);
            app.log.info(
              { callId, panelId: domophoneEndpointId, channelId },
              "Setup failed: cleared active incoming panel lock"
            );
          } catch (clearError) {
            app.log.warn(
              { err: clearError, callId, panelId: domophoneEndpointId, channelId },
              "Setup failed: failed to clear active incoming panel lock"
            );
          }
        }
        if (createdBridgeId) {
          await cleanupBridge(
            createdBridgeId,
            channelId,
            { callId, channelId, source: "setupFailed" },
            app.log
          );
        }
        await removeTemporarySipEndpoint(endpointId, { callId, channelId, source: "setupFailed" });
        await hangupChannel(channelId, app.log);
      }

      // Ring push + ring timeout only when the room was fully assembled.
      if (bridgeId) {
        const outcomeBeforeRingPush = await getDialStatus(callId);
        if (outcomeBeforeRingPush !== null) {
          app.log.info(
            { callId, outcome: outcomeBeforeRingPush },
            "Skipping ring push: call outcome already claimed"
          );
        } else {
        const records = await listPushTokens(userId);
        app.log.info({ tokensCount: records.length, userId }, "Push tokens retrieved");
        if (records.length === 0) {
          app.log.warn({ userId }, "No push tokens for user");
        } else {
        const androidTokens = records.filter((r) => r.platform === "android").map((r) => r.pushToken);
        const iosVoipTokens = records.filter((r) => r.platform === "ios_voip").map((r) => r.pushToken);
        const sipCredentials = { username: sipUsername, password: sipPassword, domain: env.serverDomain };
        const callPayload = {
          type: "SIP_CALL" as const,
          callId,
          sipCredentials: JSON.stringify(sipCredentials),
          address,
        };
        const invalidTokens: string[] = [];
        let fcmInvalidCount = 0;
        let apnsInvalidCount = 0;
        const ringPushTasks: Promise<void>[] = [];
        if (androidTokens.length > 0) {
        app.log.info({ callId, tokensCount: androidTokens.length }, "Sending FCM push (call, data-only)");
        ringPushTasks.push(
          (async () => {
            try {
              const { invalidTokens: fcmInvalid } = await sendFcmPush(androidTokens, callPayload);
              fcmInvalidCount = fcmInvalid.length;
              invalidTokens.push(...fcmInvalid);
              app.log.info({ callId, tokensCount: androidTokens.length }, "FCM push (call) sent");
            } catch (pushError) {
              app.log.error({ err: pushError, callId }, "FCM push failed, continuing call setup (timeout will still run)");
            }
          })()
        );
        }
        if (iosVoipTokens.length > 0) {
        app.log.info({ callId, tokensCount: iosVoipTokens.length }, "Sending APNs VoIP push (call)");
        ringPushTasks.push(
          (async () => {
            try {
              const { invalidTokens: apnsInvalid } = await sendApnsVoipPush(iosVoipTokens, callPayload);
              apnsInvalidCount = apnsInvalid.length;
              invalidTokens.push(...apnsInvalid);
              app.log.info({ callId, tokensCount: iosVoipTokens.length }, "APNs VoIP push (call) sent");
            } catch (pushError) {
              app.log.error({ err: pushError, callId }, "APNs VoIP push failed, continuing call setup (timeout will still run)");
            }
          })()
        );
        }
        await Promise.all(ringPushTasks);
          if (invalidTokens.length > 0) {
            await removePushTokens(userId, invalidTokens);
            if (fcmInvalidCount > 0) {
              app.log.info({ callId, userId, removedCount: fcmInvalidCount }, "Removed invalid FCM tokens from DB");
            }
            if (apnsInvalidCount > 0) {
              app.log.info({ callId, userId, removedCount: apnsInvalidCount }, "Removed invalid APNs tokens from DB");
            }
          }
          const outcomeAfterRingPush = await getDialStatus(callId);
          const endedReasonAfterRing = callOutcomeToEndedReason(outcomeAfterRingPush);
          if (endedReasonAfterRing !== null) {
            const callDataAfterRing = await getCallData<CallData>(callId);
            if (callDataAfterRing) {
              app.log.info(
                { callId, outcome: outcomeAfterRingPush, reason: endedReasonAfterRing },
                "Call ended while ring push was in flight; sending call-ended push"
              );
              await notifyCallOver(callId, callDataAfterRing, endedReasonAfterRing, app.log);
            }
          }
        }
      }

      // If nobody answers, auto-end the call on backend after ring timeout.
        const capturedBridgeId = bridgeId;
        void (async () => {
          try {
            await new Promise((r) => setTimeout(r, env.ringTimeoutSec * 1000));
            const outcome = await getDialStatus(callId);
            if (outcome !== null) {
              app.log.debug({ callId, channelId, bridgeId: capturedBridgeId, outcome }, "Call already processed, skipping timeout");
              return;
            }

            const callData = await getCallData<CallData>(callId);

            app.log.warn({ callId, channelId, bridgeId: capturedBridgeId, ringTimeoutSec: env.ringTimeoutSec }, "Incoming call timed out - sending domophone to noanswer");
            const claimed = await setDialStatus(callId, "timedOut", env.callTokenTtlSec);
            if (!claimed) {
              app.log.debug({ callId, channelId, bridgeId: capturedBridgeId }, "Call outcome already claimed, skipping timeout");
              return;
            }
            if (callData?.endpointId) {
              try {
                await deletePendingOriginate(callData.endpointId);
                app.log.info(
                  { callId, endpointId: callData.endpointId },
                  "Timed out: cleared pending originate"
                );
              } catch (pendingError) {
                app.log.warn(
                  { err: pendingError, callId, endpointId: callData.endpointId },
                  "Timed out: failed to clear pending originate"
                );
              }
            }

            try {
              await continueInDialplan(channelId, "from-domophone", "noanswer", 1);
              app.log.info({ channelId, callId }, "Timed out: domophone channel sent to noanswer");
            } catch (continueError) {
              app.log.warn({ err: continueError, channelId }, "Failed to continueInDialplan timed out channel");
            }
            const originateChannelIds = await listDialedChannels(callId);
            for (const originateChannelId of originateChannelIds) {
              if ((await hangupChannel(originateChannelId, app.log)) === "hungUp") {
                app.log.info({ callId, originateChannelId }, "Timed out: hung up originate channel");
              }
            }
            if (callData) {
              await notifyCallOver(callId, callData, "timeout", app.log);
            } else {
              app.log.warn({ callId }, "No call data for call-ended push, skipping push");
            }
            await cleanupBridge(
              capturedBridgeId,
              channelId,
              { callId, channelId, source: "timedOut" },
              app.log
            );
            if (callData?.domophoneEndpointId) {
              await deleteCallingPanel(callData.domophoneEndpointId);
            }
          } catch (error) {
            app.log.warn({ err: error, callId }, "Failed to auto-end timed out call");
          }
        })();
      }
    } catch (error) {
      app.log.error({ err: error }, "Failed to handle StasisStart");
    }
  }

  if (event.type === "StasisEnd" && typeof event.channel === "object" && event.channel) {
    const channel = event.channel as { id?: string };
    if (!channel.id) return;
    const channelId = channel.id;
    
    app.log.info({ channelId }, "StasisEnd - channel terminated, cleaning up bridge");

    const channelSession = await getChannelSession<ChannelSession>(channelId);
    let callData: CallData | null = null;
    if (channelSession?.callId) {
      callData = await getCallData<CallData>(channelSession.callId);
    }
    const bridgeId = callData?.bridgeId ?? channelSession?.bridgeId;
    if (bridgeId) {
      await cleanupBridge(bridgeId, undefined, { channelId, source: "stasisEnd" }, app.log);
    } else {
      app.log.debug({ channelId }, "No bridgeId in channel session or call data, skipping bridge cleanup");
    }

    const callId = channelSession?.callId;
    if (callId && callData) {
      const claimed = await setDialStatus(callId, "canceled", env.callTokenTtlSec);
      if (claimed) {
        if (callData.endpointId) {
          try {
            await deletePendingOriginate(callData.endpointId);
            app.log.info(
              { callId, endpointId: callData.endpointId, channelId },
              "StasisEnd: cleared pending originate for ended pending call"
            );
          } catch (pendingError) {
            app.log.warn(
              { err: pendingError, callId, endpointId: callData.endpointId, channelId },
              "StasisEnd: failed to clear pending originate for ended pending call"
            );
          }
        }
      }

      const originateChannelIds = await listDialedChannels(callId);
      for (const originateChannelId of originateChannelIds) {
        if ((await hangupChannel(originateChannelId, app.log)) === "hungUp") {
          app.log.info({ originateChannelId, channelId, callId }, "StasisEnd: hung up originate channel");
        }
      }

      if (claimed) {
        await notifyCallOver(callId, callData, "caller_hung_up", app.log);
      } else {
        const outcome = await getDialStatus(callId);
        if (outcome === "accepted") {
          await notifyCallOver(callId, callData, "ended", app.log);
        }
      }

      if (callData.domophoneEndpointId) {
        await deleteCallingPanel(callData.domophoneEndpointId);
      }

      if (callData.endpointId) {
        const outcome = await getDialStatus(callId);
        if (outcome !== null) {
          armEndpointRemoval(callData.endpointId, { callId, channelId, source: "stasisEnd" });
        }
      }
    }

    // Redis will cleanup session data automatically by TTL
  }

  if (event.type === "ChannelLeftBridge" && typeof event.bridge === "object" && event.bridge) {
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
  }
}

app.get("/health", async () => {
  return { ok: true, service: "intercom-backend", config: { baseUrl: env.serverDomain } };
});

/**
 * Cleanup temporary endpoints if Redis TTL expired.
 * Redis cleans up data automatically by TTL; here we remove leftover Postgres rows and ARI objects.
 */
const cleanupStaleEndpoints = async () => {
  try {
    const endpointIds = await listTempEndpoints();
    for (const endpointId of endpointIds) {
      const session = await getEndpointSession<{ type: "incoming" | "outgoing" }>(endpointId);
      const callId = getCallId(endpointId);
      const callData = callId ? await getCallData<CallData>(callId) : null;

      if (session && callData) {
        continue;
      }

      await removeTemporarySipEndpoint(endpointId, { reason: "ttl-expired" });
    }
  } catch (error) {
    app.log.warn({ err: error }, "Cleanup: failed to cleanup stale endpoints");
  }
};

/**
 * Интервал дворника временных учёток.
 *
 * После событийного снятия он страховка, не основной уборщик.
 */
const STALE_ENDPOINT_CLEANUP_MS = 10 * 60 * 1000;

let isCleaningStaleEndpoints = false;

const parseAriTimestamp = (value: string | undefined): number | null => {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  // Asterisk Date strings use +0000 / -0600; Date.parse needs a colon in the offset.
  const normalized = value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? null : ms;
};

const isTemporaryEndpointChannel = (name: string | undefined): boolean => {
  const namePart = name?.split("/")[1];
  return Boolean(namePart && (namePart.startsWith("inc_") || namePart.startsWith("out_")));
};

/**
 * Hang up leftover temp-endpoint channels older than maxCallDurationSec.
 * Age-only: a live bridged talk past the limit is hung up too.
 */
const hangupOverdueChannels = async () => {
  try {
    const channels = await listChannels();
    const maxAgeMs = env.maxCallDurationSec * 1000;
    const now = Date.now();
    for (const channel of channels) {
      if (!isTemporaryEndpointChannel(channel.name)) {
        continue;
      }
      const createdAtMs = parseAriTimestamp(channel.creationtime);
      if (createdAtMs === null) {
        app.log.warn(
          { channelId: channel.id, name: channel.name, creationtime: channel.creationtime },
          "Cleanup: skipped overdue hangup, could not parse channel creationtime"
        );
        continue;
      }
      const ageMs = now - createdAtMs;
      if (ageMs <= maxAgeMs) {
        continue;
      }
      app.log.warn(
        { channelId: channel.id, name: channel.name, ageSec: Math.floor(ageMs / 1000) },
        "Cleanup: hanging up overdue channel"
      );
      await hangupChannel(channel.id, app.log);
    }
  } catch (error) {
    app.log.warn({ err: error }, "Cleanup: failed to hang up overdue channels");
  }
};

let isHangingUpOverdueChannels = false;

/**
 * Split PJSIP_DIAL_CONTACTS output into ARI originate endpoints.
 */
const parseDialContacts = (dialString: string): string[] => {
  return dialString
    .split("&")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
};

type DialPendingSource = "event" | "poll";

/**
 * Статусы «контакт появился».
 *
 * NonQualified — норма: частоту проверки доступности мы не задаём.
 * Removed и Unreachable сюда не входят.
 */
const CONTACT_APPEARED_STATUSES = new Set(["Created", "NonQualified", "Reachable", "Unknown"]);

/**
 * Адрес записи и статус контакта временной учётки из события.
 *
 * Иначе null: чужая учётка или битое тело события.
 */
const readContactStatus = (event: AriEvent): { aor: string; contactStatus: string } | null => {
  const contactInfo = event.contact_info;
  if (!contactInfo || typeof contactInfo !== "object") {
    return null;
  }
  const info = contactInfo as { aor?: unknown; contact_status?: unknown };
  if (typeof info.aor !== "string" || info.aor.length === 0) {
    return null;
  }
  if (typeof info.contact_status !== "string") {
    return null;
  }
  if (!info.aor.startsWith("inc_") && !info.aor.startsWith("out_")) {
    return null;
  }
  return { aor: info.aor, contactStatus: info.contact_status };
};

/**
 * Адрес записи временной учётки, если в событии контакт только что появился.
 */
const readAppearedContactAor = (event: AriEvent): string | null => {
  const contact = readContactStatus(event);
  if (!contact || !CONTACT_APPEARED_STATUSES.has(contact.contactStatus)) {
    return null;
  }
  return contact.aor;
};

/**
 * Адрес записи временной учётки, если в событии контакт снялся.
 */
const readRemovedContactAor = (event: AriEvent): string | null => {
  const contact = readContactStatus(event);
  if (!contact || contact.contactStatus !== "Removed") {
    return null;
  }
  return contact.aor;
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
    const callData = await getCallData<CallData>(callId);
    if (callData?.channelId) {
      channelIds.push(callData.channelId);
    }
    channelIds.push(...(await listDialedChannels(callId)));
  }
  const pending = await getPendingOriginate<{ channelId: string }>(endpointId);
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
const removeEndpointIfNoContacts = async (endpointId: string) => {
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
  await removeTemporarySipEndpoint(endpointId, { callId, reason: "last-contact-removed" });
};

/**
 * Дозвонить на контакты временной учётки, если дозвон ещё ждёт.
 *
 * Контакты читает с канала панели через PJSIP_DIAL_CONTACTS, чтобы строка
 * приглашения не отличалась от опроса. Цикл и событие зовут одну функцию.
 *
 * @param endpointId — id временной оконечной точки
 * @param source — откуда вызвали, пишется в лог
 */
const dialPendingContacts = async (endpointId: string, source: DialPendingSource) => {
  const pending = await getPendingOriginate<{ bridgeId: string; channelId: string }>(
    endpointId
  );
  if (!pending) {
    return;
  }

  const pendingChannelSession = await getChannelSession<ChannelSession>(pending.channelId);
  const pendingCallId = pendingChannelSession?.callId;
  if (!pendingCallId) {
    await deletePendingOriginate(endpointId);
    app.log.info({ endpointId, channelId: pending.channelId, source }, "Dropped stale pending originate: no callId for channel");
    return;
  }

  const pendingCallData = await getCallData<CallData>(pendingCallId);
  const pendingOutcome = await getDialStatus(pendingCallId);
  if (
    !pendingCallData ||
    pendingOutcome !== null ||
    pendingCallData.endpointId !== endpointId
  ) {
    await deletePendingOriginate(endpointId);
    app.log.info(
      {
        endpointId,
        callId: pendingCallId,
        outcome: pendingOutcome,
        actualEndpointId: pendingCallData?.endpointId,
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

    const appArgs = `outgoing,${pending.bridgeId},${endpointId}`;
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
        const originated = await originateCall(dialContact, appArgs);
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
      await deletePendingOriginate(endpointId);
      return;
    }
    if (!panelChannelAlive || outcomeAfterOriginate !== null) {
      const originateChannelIds = await listDialedChannels(pendingCallId);
      for (const originatedId of originateChannelIds) {
        await hangupChannel(originatedId, app.log);
      }
      await deletePendingOriginate(endpointId);
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
const checkPendingOriginate = async () => {
  try {
    const endpointIds = await listTempEndpoints();
    for (const endpointId of endpointIds) {
      await dialPendingContacts(endpointId, "poll");
    }
  } catch (error) {
    app.log.warn({ err: error }, "Failed to check pending originate");
  }
};

let isCheckingPendingOriginate = false;

/**
 * Запускает сервер по порядку: база, маршруты, воркер, таймеры, ARI, приём запросов.
 *
 * Ошибка базы или listen завершает процесс: без базы сервер принимать запросы не должен.
 */
async function start(): Promise<void> {
  // База раньше остального: без таблиц маршруты и дворники падают на первом обращении.
  try {
    await createDatabaseSchema();
    await seedEndpointTemplates();
  } catch (error) {
    app.log.error({ err: error }, "Failed to ensure database schema");
    process.exit(1);
  }

  // Маршруты:
  //  - /auth/* — регистрация телефона и подтверждение кода,
  //  - /push/register — привязка push-токена,
  //  - /calls/* — выдача SIP-учётки и завершение звонка.
  await registerAuthRoutes(app);
  await registerPushRoutes(app);
  await registerCallRoutes(app);

  // Воркер OTP — бесконечный цикл чтения очереди Redis. Ждать его нельзя.
  // Ошибка логируется и не роняет сервер: падение воркера не должно убивать обработку звонков.
  void startOtpDialer(app).catch((error) => {
    app.log.error({ err: error }, "OTP dialer stopped unexpectedly");
  });

  // Таймеры после базы. Опрос дозвона идёт раз в 2 секунды и читает Postgres.
  const staleEndpointsTimer = setInterval(() => {
    if (isCleaningStaleEndpoints) {
      app.log.debug("Cleanup: skipping stale endpoints, previous pass still running");
      return;
    }
    isCleaningStaleEndpoints = true;
    cleanupStaleEndpoints()
      .catch((error) => {
        app.log.error({ err: error }, "Cleanup: failed to cleanup stale endpoints");
      })
      .finally(() => {
        isCleaningStaleEndpoints = false;
      });
  }, STALE_ENDPOINT_CLEANUP_MS);

  const overdueChannelsTimer = setInterval(() => {
    if (isHangingUpOverdueChannels) {
      app.log.debug("Cleanup: skipping overdue channels, previous pass still running");
      return;
    }
    isHangingUpOverdueChannels = true;
    hangupOverdueChannels()
      .catch((error) => {
        app.log.error({ err: error }, "Cleanup: failed to hang up overdue channels");
      })
      .finally(() => {
        isHangingUpOverdueChannels = false;
      });
  }, 60000);

  // Check every 2 seconds for pending originate requests
  const pendingOriginateTimer = setInterval(() => {
    if (isCheckingPendingOriginate) {
      app.log.debug("Skipping pending originate check, previous pass still running");
      return;
    }
    isCheckingPendingOriginate = true;
    checkPendingOriginate()
      .catch((error) => {
        app.log.error({ err: error }, "Failed to check pending originate");
      })
      .finally(() => {
        isCheckingPendingOriginate = false;
      });
  }, 2000);

  app.addHook("onClose", async () => {
    clearInterval(staleEndpointsTimer);
    clearInterval(overdueChannelsTimer);
    clearInterval(pendingOriginateTimer);
    for (const endpointId of [...endpointRemovalTimers.keys()]) {
      cancelEndpointRemoval(endpointId);
    }
  });

  function shutdown() {
    void app.close();
  }
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  // Сокет ARI после базы: первые события сразу читают Redis и Postgres.
  app.log.info("Connecting to ARI WebSocket");
  connectAriEvents(handleAriEvent, app.log);

  const protocol = httpsOptions ? "https" : "http";
  app.log.info({ protocol, port: env.appPort, hasCertificates }, "Starting server");
  await app.listen({ port: env.appPort, host: "0.0.0.0" });
}

void start().catch((error) => {
  app.log.error({ err: error }, "Failed to start server");
  process.exit(1);
});
