import Fastify from "fastify";
import sensible from "@fastify/sensible";
import fs from "fs";
import { env } from "./config/env";
import { createDatabaseSchema, sipEndpointTemplates } from "./store/postgres";
import { registerAuthRoutes } from "./routes/auth";
import { registerPushRoutes } from "./routes/push";
import { registerCallRoutes } from "./routes/calls";
import { teardownBridge } from "./calls/teardown";
import { handleOtpChannelDestroyed, startOtpWorker } from "./otp/worker";
import {
  connectAriEvents,
  answerChannel,
  createBridge,
  addChannelToBridge,
  hangupChannel,
  hangupChannelIfExists,
  originateCall,
  getChannel,
  listChannels,
  getChannelVariable,
  getBridge,
  deleteEndpoint,
  continueInDialplan,
} from "./ari/client";
import {
  getPushTokenRecords,
  deletePushTokens,
  getAddressById,
  formatAddress,
  getPanel,
  getUser,
  createTempSipEndpoint,
  getTempSipEndpoints,
} from "./store/postgres";
import {
  setCallData,
  setChannelSession,
  setEndpointSession,
  getEndpointSession,
  getCallData,
  claimCallOutcome,
  getCallOutcome,
  addOriginateChannelId,
  getOriginateChannelIds,
  claimContactForDial,
  releaseContactForDial,
  getCallIdByEndpointId,
  setPendingOriginate,
  getPendingOriginate,
  deletePendingOriginate,
  getChannelSession,
  getActiveIncomingFromPanel,
  setActiveIncomingFromPanel,
  clearActiveIncomingFromPanel,
} from "./store/redis";
import { sendFcmCallEnded, sendFcmPush } from "./push/fcm";
import { sendApnsCallEndedPush, sendApnsVoipPush } from "./push/apns";
import crypto from "crypto";

import type { ChannelSession, CallData } from "./types";

const config = {
  appPort: env.appPort,
  baseUrl: env.serverDomain,
};

const extractApartment = (channel: { dialplan?: { exten?: string }; connected?: { number?: string } }): string | null => {
  const exten = channel.dialplan?.exten?.trim();
  if (exten && /^\d+$/.test(exten)) return exten;

  const connectedNumber = channel.connected?.number?.trim();
  if (connectedNumber && /^\d+$/.test(connectedNumber)) return connectedNumber;

  return null;
};

// Check for SSL certificates
const certPath = `/etc/letsencrypt/live/${env.serverDomain}/fullchain.pem`;
const keyPath = `/etc/letsencrypt/live/${env.serverDomain}/privkey.pem`;
const hasCertificates = fs.existsSync(certPath) && fs.existsSync(keyPath);

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

const app = Fastify({
  logger: { level: env.logLevel },
  ...(httpsOptions ? { https: httpsOptions } : {}),
});
app.register(sensible);

createDatabaseSchema()
  .then(() => sipEndpointTemplates())
  .catch((error) => {
    app.log.error({ err: error }, "Failed to ensure database schema");
    process.exit(1);
  });

registerAuthRoutes(app);
registerPushRoutes(app);
registerCallRoutes(app);
void startOtpWorker(app).catch((error) => {
  app.log.error({ err: error }, "OTP worker stopped unexpectedly");
});

app.log.info("Connecting to ARI WebSocket");

const INCOMING_MAX_CONTACTS = 8;

const removeTemporarySipEndpoint = async (
  endpointId: string,
  logCtx: Record<string, unknown>
) => {
  try {
    await deleteEndpoint(endpointId);
    app.log.debug({ endpointId, ...logCtx }, "Temporary SIP endpoint removed");
  } catch (err) {
    app.log.warn(
      { err, endpointId, ...logCtx },
      "Failed to delete temporary SIP endpoint from ARI"
    );
  }
};

const CALL_ENDED_PUSH_TITLE = "Пропущенный вызов";
const CALL_ENDED_PUSH_BODY_DEFAULT = "Домофон";

/**
 * Notify devices that the call ended without user action (timeout or canceled).
 * Android gets FCM; iPhone gets a regular (non-VoIP) APNs alert.
 */
const sendCallEndedPush = async (
  callId: string,
  callData: CallData,
  reason: "timeout" | "caller_hung_up"
) => {
  try {
    const userId = callData.userId ?? null;
    if (userId === null) {
      app.log.warn(
        {
          callId,
          reason,
          domophoneEndpointId: callData.domophoneEndpointId,
          apartment: callData.apartment,
        },
        "No user mapping for call-ended push, skipping push"
      );
      return;
    }

    const records = await getPushTokenRecords(userId);
    const androidTokens = records.filter((r) => r.platform === "android").map((r) => r.pushToken);
    const iosApnsTokens = records.filter((r) => r.platform === "ios_apns").map((r) => r.pushToken);
    if (androidTokens.length === 0 && iosApnsTokens.length === 0) {
      app.log.warn(
        { callId, reason, userId },
        "No push tokens for call-ended push, skipping push"
      );
      return;
    }

    const address = callData.address ?? "";
    const body =
      callData.address != null && callData.address !== ""
        ? callData.address
        : CALL_ENDED_PUSH_BODY_DEFAULT;
    const title = CALL_ENDED_PUSH_TITLE;
    const invalidTokens: string[] = [];
    let fcmInvalidCount = 0;
    let apnsInvalidCount = 0;

    if (androidTokens.length > 0) {
      app.log.info(
        { callId, reason, tokensCount: androidTokens.length },
        "Sending FCM call-ended push"
      );
      try {
        const { invalidTokens: fcmInvalid } = await sendFcmCallEnded(androidTokens, {
          type: "SIP_CALL_ENDED",
          callId,
          address,
          reason,
          title,
          body,
        });
        fcmInvalidCount = fcmInvalid.length;
        invalidTokens.push(...fcmInvalid);
        app.log.info({ callId }, "FCM call-ended push sent");
      } catch (error) {
        app.log.warn({ err: error, callId, reason }, "Failed to send FCM call-ended push");
      }
    }

    if (iosApnsTokens.length > 0) {
      app.log.info(
        { callId, reason, tokensCount: iosApnsTokens.length },
        "Sending APNs call-ended push"
      );
      try {
        const { invalidTokens: apnsInvalid } = await sendApnsCallEndedPush(iosApnsTokens, {
          type: "SIP_CALL_ENDED",
          callId,
          reason,
          title,
          body,
        });
        apnsInvalidCount = apnsInvalid.length;
        invalidTokens.push(...apnsInvalid);
        app.log.info({ callId }, "APNs call-ended push sent");
      } catch (error) {
        app.log.warn({ err: error, callId, reason }, "Failed to send APNs call-ended push");
      }
    }

    if (invalidTokens.length > 0) {
      await deletePushTokens(userId, invalidTokens);
      if (fcmInvalidCount > 0) {
        app.log.info(
          { callId, userId, removedCount: fcmInvalidCount },
          "Removed invalid FCM tokens from DB (call-ended)"
        );
      }
      if (apnsInvalidCount > 0) {
        app.log.info(
          { callId, userId, removedCount: apnsInvalidCount },
          "Removed invalid APNs tokens from DB (call-ended)"
        );
      }
    }
  } catch (error) {
    app.log.warn({ err: error, callId, reason }, "Failed to send call-ended push");
  }
};

connectAriEvents(async (event) => {
  // Log all events for debugging
  app.log.info({ eventType: event.type, fullEvent: JSON.stringify(event, null, 2) }, "ARI event received");

  if (event.type === "ChannelDestroyed" && typeof event.channel === "object" && event.channel) {
    const channel = event.channel as { id?: string };
    if (!channel.id) return;
    const channelId = channel.id;

    try {
      const isOtpChannel = await handleOtpChannelDestroyed(app, channelId);
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
      dialplan?: { exten?: string };
      caller?: { number?: string; name?: string };
      connected?: { number?: string };
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
      const callIdForStatus = endpointIdFromArgs ? getCallIdByEndpointId(endpointIdFromArgs) : null;
      if (bridgeId) {
        if (callIdForStatus) {
          const claimed = await claimCallOutcome(callIdForStatus, "accepted", env.callTokenTtlSec);
          if (!claimed) {
            const outcome = await getCallOutcome(callIdForStatus);
            if (outcome === "accepted") {
              await hangupChannelIfExists(channelId, "answered_elsewhere");
            } else {
              await hangupChannelIfExists(channelId, "normal");
            }
            app.log.info(
              { channelId, callId: callIdForStatus, outcome },
              "Outgoing channel lost race or call already ended"
            );
            return;
          }
          app.log.info({ callId: callIdForStatus }, "Call marked as accepted (timeout will not hang up)");
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
            const originateChannelIds = await getOriginateChannelIds(callIdForStatus);
            for (const originateChannelId of originateChannelIds) {
              if (originateChannelId === channelId) continue;
              await hangupChannelIfExists(originateChannelId, "answered_elsewhere");
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
            const originateChannelIds = await getOriginateChannelIds(callIdForStatus);
            for (const originateChannelId of originateChannelIds) {
              await hangupChannelIfExists(originateChannelId);
            }
            await hangupChannelIfExists(channelId);
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
      const apartment = apartmentFromArgs && /^\d+$/.test(apartmentFromArgs)
        ? apartmentFromArgs
        : extractApartment(channel);
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
          const addressRecord = await getAddressById(panel.address_id);
          if (!addressRecord) {
            app.log.warn({ callId, panelIp, addressId: panel.address_id }, "Address not found for panel");
          } else {
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

      if (domophoneEndpointId) {
        const claimed = await setActiveIncomingFromPanel(
          domophoneEndpointId,
          callId,
          env.callTokenTtlSec
        );
        if (!claimed) {
          const existingCallId = await getActiveIncomingFromPanel(domophoneEndpointId);
          app.log.info(
            { panelId: domophoneEndpointId, existingCallId, channelId },
            "Ignoring duplicate incoming from same panel"
          );
          try {
            await hangupChannel(channelId);
            app.log.info({ channelId }, "Hung up duplicate channel so it does not hang in Stasis");
          } catch (err) {
            app.log.warn({ err, channelId }, "Failed to hang up duplicate channel");
          }
          return;
        }
      }
      const endpointId = `inc_${callId}`;
      const sipUsername = endpointId;
      const sipPassword = crypto.randomBytes(8).toString("hex");

      app.log.info({ endpointId, sipUsername, sipPassword, context: "intercom", maxContacts: INCOMING_MAX_CONTACTS }, "Creating temporary SIP endpoint");
      await createTempSipEndpoint({
        context: "intercom",
        id: endpointId,
        maxContacts: INCOMING_MAX_CONTACTS,
        password: sipPassword,
        templateId: "tpl_client",
        username: sipUsername,
      });
      app.log.info({ endpointId }, "Temporary SIP endpoint created");
      await setEndpointSession(endpointId, { type: "incoming" }, env.callTokenTtlSec);

      // Bridge and originate: same logic as previously in GET /calls/credentials
      let bridgeId: string | undefined;
      try {
        app.log.info({ callId, channelId, endpointId }, "STEP 1: Creating bridge and setting up originate");
        const bridge = await createBridge();
        bridgeId = bridge.id;
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
      } catch (error) {
        app.log.error({ err: error, callId, channelId, endpointId }, "CRITICAL: Failed to setup bridge/originate - call will not connect");
      }

      if (userId === null) {
        app.log.warn({ callId, domophoneEndpointId, panelIp, apartment }, "No user mapping for incoming call, skipping push");
      } else {
        const records = await getPushTokenRecords(userId);
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
          ...(address ? { address } : {}),
        };
        const invalidTokens: string[] = [];
        let fcmInvalidCount = 0;
        let apnsInvalidCount = 0;
        if (androidTokens.length > 0) {
        app.log.info({ callId, tokensCount: androidTokens.length }, "Sending FCM push (call, data-only)");
        try {
          const { invalidTokens: fcmInvalid } = await sendFcmPush(androidTokens, callPayload);
          fcmInvalidCount = fcmInvalid.length;
          invalidTokens.push(...fcmInvalid);
          app.log.info({ callId, tokensCount: androidTokens.length }, "FCM push (call) sent");
        } catch (pushError) {
          app.log.error({ err: pushError, callId }, "FCM push failed, continuing call setup (timeout will still run)");
        }
        }
        if (iosVoipTokens.length > 0) {
        app.log.info({ callId, tokensCount: iosVoipTokens.length }, "Sending APNs VoIP push (call)");
        try {
          const { invalidTokens: apnsInvalid } = await sendApnsVoipPush(iosVoipTokens, callPayload);
          apnsInvalidCount = apnsInvalid.length;
          invalidTokens.push(...apnsInvalid);
          app.log.info({ callId, tokensCount: iosVoipTokens.length }, "APNs VoIP push (call) sent");
        } catch (pushError) {
          app.log.error({ err: pushError, callId }, "APNs VoIP push failed, continuing call setup (timeout will still run)");
        }
        }
          if (invalidTokens.length > 0) {
            await deletePushTokens(userId, invalidTokens);
            if (fcmInvalidCount > 0) {
              app.log.info({ callId, userId, removedCount: fcmInvalidCount }, "Removed invalid FCM tokens from DB");
            }
            if (apnsInvalidCount > 0) {
              app.log.info({ callId, userId, removedCount: apnsInvalidCount }, "Removed invalid APNs tokens from DB");
            }
          }
        }
      }

      // If nobody answers, auto-end the call on backend after ring timeout.
      if (bridgeId) {
        const capturedBridgeId = bridgeId;
        void (async () => {
          try {
            await new Promise((r) => setTimeout(r, env.ringTimeoutSec * 1000));
            const outcome = await getCallOutcome(callId);
            if (outcome !== null) {
              app.log.debug({ callId, channelId, bridgeId: capturedBridgeId, outcome }, "Call already processed, skipping timeout");
              return;
            }

            const callData = await getCallData<CallData>(callId);

            app.log.warn({ callId, channelId, bridgeId: capturedBridgeId, ringTimeoutSec: env.ringTimeoutSec }, "Incoming call timed out - sending domophone to noanswer");
            const claimed = await claimCallOutcome(callId, "timeout", env.callTokenTtlSec);
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
            const originateChannelIds = await getOriginateChannelIds(callId);
            for (const originateChannelId of originateChannelIds) {
              if ((await hangupChannelIfExists(originateChannelId)) === "hung_up") {
                app.log.info({ callId, originateChannelId }, "Timed out: hung up originate channel");
              }
            }
            if (callData) {
              await sendCallEndedPush(callId, callData, "timeout");
            } else {
              app.log.warn({ callId }, "No call data for call-ended push, skipping push");
            }
            await teardownBridge(
              capturedBridgeId,
              channelId,
              { callId, channelId, source: "Timed out" },
              app.log
            );
            if (callData?.domophoneEndpointId) {
              await clearActiveIncomingFromPanel(callData.domophoneEndpointId);
            }
          } catch (error) {
            app.log.warn({ err: error, callId }, "Failed to auto-end timed out call");
          }
        })();
      } else {
        app.log.warn({ callId, channelId }, "No bridgeId available, skipping timeout setup");
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
      await teardownBridge(bridgeId, undefined, { channelId, source: "StasisEnd" }, app.log);
    } else {
      app.log.debug({ channelId }, "No bridgeId in channel session or call data, skipping bridge cleanup");
    }

    const callId = channelSession?.callId;
    if (callId && callData) {
      const claimed = await claimCallOutcome(callId, "canceled", env.callTokenTtlSec);
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

      const originateChannelIds = await getOriginateChannelIds(callId);
      for (const originateChannelId of originateChannelIds) {
        if ((await hangupChannelIfExists(originateChannelId)) === "hung_up") {
          app.log.info({ originateChannelId, channelId, callId }, "StasisEnd: hung up originate channel");
        }
      }

      if (claimed) {
        await sendCallEndedPush(callId, callData, "caller_hung_up");
      }

      if (callData.domophoneEndpointId) {
        await clearActiveIncomingFromPanel(callData.domophoneEndpointId);
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
    await teardownBridge(bridgeId, undefined, { source: "ChannelLeftBridge" }, app.log);
  }
});

app.get("/health", async () => {
  return { ok: true, service: "intercom-backend", config: { baseUrl: config.baseUrl } };
});

/**
 * Cleanup temporary endpoints if Redis TTL expired.
 * Redis cleans up data automatically by TTL; here we remove leftover Postgres rows and ARI objects.
 */
const cleanupStaleEndpoints = async () => {
  try {
    const endpointIds = await getTempSipEndpoints();
    for (const endpointId of endpointIds) {
      const session = await getEndpointSession<{ type: "incoming" | "outgoing" }>(endpointId);
      const callId = getCallIdByEndpointId(endpointId);
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

let isCleaningStaleEndpoints = false;
setInterval(() => {
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
}, 60000);

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
      await hangupChannelIfExists(channel.id);
    }
  } catch (error) {
    app.log.warn({ err: error }, "Cleanup: failed to hang up overdue channels");
  }
};

let isHangingUpOverdueChannels = false;
setInterval(() => {
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

/**
 * Split PJSIP_DIAL_CONTACTS output into ARI originate endpoints.
 */
const parseDialContacts = (dialString: string): string[] => {
  return dialString
    .split("&")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
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
    const endpointIds = await getTempSipEndpoints();
    for (const endpointId of endpointIds) {
      const pending = await getPendingOriginate<{ bridgeId: string; channelId: string }>(
        endpointId
      );
      if (pending) {
        const pendingChannelSession = await getChannelSession<ChannelSession>(pending.channelId);
        const pendingCallId = pendingChannelSession?.callId;
        if (!pendingCallId) {
          await deletePendingOriginate(endpointId);
          app.log.info({ endpointId, channelId: pending.channelId }, "Dropped stale pending originate: no callId for channel");
          continue;
        }

        const pendingCallData = await getCallData<CallData>(pendingCallId);
        const pendingOutcome = await getCallOutcome(pendingCallId);
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
            },
            "Dropped stale pending originate: call is no longer pending"
          );
          continue;
        }

        try {
          const dialString = await getChannelVariable(
            pending.channelId,
            `PJSIP_DIAL_CONTACTS(${endpointId})`
          );
          const dialContacts = parseDialContacts(dialString);
          if (dialContacts.length === 0) {
            app.log.debug(
              { endpointId, channelId: pending.channelId },
              "No PJSIP contacts yet, keeping pending originate"
            );
            continue;
          }

          const appArgs = `outgoing,${pending.bridgeId},${endpointId}`;
          for (const dialContact of dialContacts) {
            if ((await getCallOutcome(pendingCallId)) !== null) {
              break;
            }
            const claimedContact = await claimContactForDial(
              pendingCallId,
              dialContact,
              env.ringTimeoutSec
            );
            if (!claimedContact) {
              continue;
            }
            try {
              app.log.info(
                { endpointId, bridgeId: pending.bridgeId, contact: dialContact, time: Date.now() },
                "ATTEMPTING to originate call to endpoint"
              );
              const originated = await originateCall(dialContact, appArgs);
              await addOriginateChannelId(pendingCallId, originated.id, env.callTokenTtlSec);
              app.log.info(
                {
                  endpointId,
                  bridgeId: pending.bridgeId,
                  contact: dialContact,
                  originateChannelId: originated.id,
                  time: Date.now(),
                },
                "SUCCESS: Originated call from periodic check"
              );
            } catch (error) {
              await releaseContactForDial(pendingCallId, dialContact);
              app.log.warn(
                {
                  err: error,
                  endpointId,
                  contact: dialContact,
                },
                "FAILED: Could not originate call to contact"
              );
            }
          }

          let panelChannelAlive = true;
          try {
            await getChannel(pending.channelId);
          } catch {
            panelChannelAlive = false;
          }
          const outcomeAfterOriginate = await getCallOutcome(pendingCallId);
          if (outcomeAfterOriginate === "accepted") {
            // Do not hang up here: the winner hangs up other legs. The outcome
            // check before originate guarantees every created leg is in the set
            // before the winner enumerates it.
            await deletePendingOriginate(endpointId);
            continue;
          }
          if (!panelChannelAlive || outcomeAfterOriginate !== null) {
            const originateChannelIds = await getOriginateChannelIds(pendingCallId);
            for (const originatedId of originateChannelIds) {
              await hangupChannelIfExists(originatedId);
            }
            await deletePendingOriginate(endpointId);
            continue;
          }
        } catch (error) {
          const err = error as Error & { code?: string };
          app.log.warn(
            {
              err: error,
              endpointId,
              bridgeId: pending.bridgeId,
              time: Date.now(),
              errorMessage: err?.message,
              errorCode: err?.code,
            },
            "FAILED: Could not originate call"
          );
        }
      }
    }
  } catch (error) {
    app.log.warn({ err: error }, "Failed to check pending originate");
  }
};

let isCheckingPendingOriginate = false;
// Check every 2 seconds for pending originate requests
setInterval(() => {
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

const protocol = httpsOptions ? "https" : "http";
app.log.info({ protocol, port: config.appPort, hasCertificates }, "Starting server");

app.listen({ port: config.appPort, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
