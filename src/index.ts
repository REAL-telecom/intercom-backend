import Fastify from "fastify";
import sensible from "@fastify/sensible";
import fs from "fs";
import { env } from "./config/env";
import { createDatabaseSchema, sipEndpointTemplates } from "./store/postgres";
import { registerAuthRoutes } from "./routes/auth";
import { registerPushRoutes } from "./routes/push";
import { registerCallRoutes } from "./routes/calls";
import { handleOtpChannelDestroyed, startOtpWorker } from "./otp/worker";
import {
  connectAriEvents,
  answerChannel,
  createBridge,
  addChannelToBridge,
  hangupChannel,
  subscribeToEndpointEvents,
  originateCall,
  getBridge,
  deleteBridge,
  continueInDialplan,
} from "./ari/client";
import {
  getPushTokens,
  deletePushTokens,
  getPanel,
  getUser,
  createTempSipEndpoint,
  deleteTempSipEndpoint,
  getTempSipEndpoints,
} from "./store/postgres";
import {
  setCallData,
  setChannelSession,
  setEndpointSession,
  getEndpointSession,
  getCallData,
  getCallIdByEndpointId,
  setPendingOriginate,
  getPendingOriginate,
  deletePendingOriginate,
  getChannelSession,
  getActiveIncomingFromPanel,
  setActiveIncomingFromPanel,
  clearActiveIncomingFromPanel,
} from "./store/redis";
import { sendFcmPush, sendFcmCallEnded } from "./push/fcm";
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

// Subscribe to endpoint events to receive EndpointStateChange events
app.log.info("Subscribing to endpoint events");
subscribeToEndpointEvents()
  .then(() => {
    app.log.info("Successfully subscribed to endpoint events");
  })
  .catch((error) => {
    app.log.error({ err: error }, "Failed to subscribe to endpoint events");
  });

connectAriEvents(async (event) => {
  // Log all events for debugging
  app.log.info({ eventType: event.type, fullEvent: JSON.stringify(event, null, 2) }, "ARI event received");

  // Handle EndpointStateChange events for temporary endpoints
  // When endpoint state changes, try to originate if there's a pending call
  // This works similar to how Linphone SDK detects registration - by attempting to use the endpoint
  if (event.type === "EndpointStateChange") {
    // Log complete event with all fields
    app.log.info({ 
      fullEvent: JSON.stringify(event, null, 2),
      eventKeys: Object.keys(event),
      endpointRaw: event.endpoint
    }, "EndpointStateChange event - COMPLETE DATA");
    
    const ep = event.endpoint;
    
    if (typeof ep === "object" && ep !== null) {
      const endpoint = ep as { technology?: string; resource?: string; state?: string; channel_ids?: string[]; [key: string]: any };
      
      if (endpoint.technology === "PJSIP" && endpoint.resource?.startsWith("inc_")) {
        const endpointId = endpoint.resource;
        const state = endpoint.state ?? null;

        app.log.info({ 
          endpointId, 
          state, 
          channel_ids: endpoint.channel_ids,
          fullEndpointData: JSON.stringify(endpoint, null, 2),
          allEndpointFields: endpoint
        }, "EndpointStateChange received for temporary endpoint - ALL DATA");

        // Check if there's a pending originate for this endpoint
        const pending = await getPendingOriginate<{ bridgeId: string; channelId: string }>(
          endpointId
        );

        if (pending) {
          // Only attempt originate if endpoint is online or not offline
          // Skip if endpoint is offline - it's not registered yet
          if (state === "offline" || state === "unknown") {
            app.log.debug({ endpointId, state, bridgeId: pending.bridgeId }, "Skipping originate - endpoint is not online yet");
            return;
          }

          app.log.info({ endpointId, state, bridgeId: pending.bridgeId }, "Found pending originate, attempting to originate");
          // Try to originate only if endpoint is online
          // This prevents multiple failed attempts when endpoint is offline
          try {
            const appArgs = `outgoing,${pending.bridgeId}`;
            await originateCall(`PJSIP/${endpointId}`, appArgs);
            await deletePendingOriginate(endpointId);
            app.log.info({ endpointId, bridgeId: pending.bridgeId, state }, "Originated call after endpoint state change");
          } catch (error) {
            // If originate fails, endpoint might not be fully registered yet
            // Will retry on next state change event (similar to how Linphone SDK retries)
            app.log.warn({ err: error, endpointId, state }, "Failed to originate on state change, will retry on next event");
          }
        } else {
          app.log.debug({ endpointId, state }, "No pending originate found for endpoint");
        }
      }
    }
    return;
  }

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
      if (bridgeId) {
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
                  app.log.info({ domophoneChannelId }, "CRITICAL: Answered domophone channel - call should be fully connected now");
                  const namePart = channel.name?.split("/")[1];
                  let endpointIdFromChannel: string | null = namePart ?? null;
                  if (namePart) {
                    // ARI/Asterisk appends "-<tail>" after our crafted endpoint id in channel.name.
                    // We strip everything after the last "-" and treat the rest as endpoint id.
                    const lastHyphen = namePart.lastIndexOf("-");
                    if (lastHyphen > 0) endpointIdFromChannel = namePart.slice(0, lastHyphen);
                  }
                  const callIdForStatus = endpointIdFromChannel ? getCallIdByEndpointId(endpointIdFromChannel) : null;
                  if (callIdForStatus) {
                    const callDataAccepted = await getCallData<CallData>(callIdForStatus);
                    if (callDataAccepted) {
                      await setCallData(callIdForStatus, { ...callDataAccepted, status: "accepted" }, env.callTokenTtlSec);
                      app.log.info({ callId: callIdForStatus }, "Call marked as accepted (timeout will not hang up)");
                    }
                  }
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

      app.log.info({ endpointId, sipUsername, sipPassword, context: "intercom" }, "Creating temporary SIP endpoint");
      await createTempSipEndpoint({
        id: endpointId,
        username: sipUsername,
        password: sipPassword,
        context: "intercom",
        templateId: "tpl_client",
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
            status: "pending",
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
        const tokens = await getPushTokens(userId);
        app.log.info({ tokensCount: tokens.length, userId }, "Push tokens retrieved");
        if (tokens.length === 0) {
          app.log.warn({ userId }, "No push tokens for user");
        } else {
        const sipCredentials = { username: sipUsername, password: sipPassword, domain: env.serverDomain };
        app.log.info({ callId, tokensCount: tokens.length }, "Sending FCM push (call, data-only)");
        try {
          const { invalidTokens } = await sendFcmPush(tokens, {
            type: "SIP_CALL",
            callId,
            sipCredentials: JSON.stringify(sipCredentials),
            ...(address ? { address } : {}),
          });
          if (invalidTokens.length > 0) {
            await deletePushTokens(userId, invalidTokens);
            app.log.info({ callId, userId, removedCount: invalidTokens.length }, "Removed invalid FCM tokens from DB");
          }
          app.log.info({ callId, tokensCount: tokens.length }, "FCM push (call) sent");
        } catch (pushError) {
          app.log.error({ err: pushError, callId }, "FCM push failed, continuing call setup (timeout will still run)");
        }
        }
      }

      // If nobody answers, auto-end the call on backend after ring timeout.
      if (bridgeId) {
        const capturedBridgeId = bridgeId;
        void (async () => {
          try {
            await new Promise((r) => setTimeout(r, env.ringTimeoutSec * 1000));
            const callData = await getCallData<CallData>(callId);
            if (!callData || callData.status !== "pending") {
              app.log.debug({ callId, channelId, bridgeId: capturedBridgeId, status: callData?.status }, "Call already processed, skipping timeout");
              return;
            }

            app.log.warn({ callId, channelId, bridgeId: capturedBridgeId, ringTimeoutSec: env.ringTimeoutSec }, "Incoming call timed out - sending domophone to noanswer");
            await setCallData(callId, { ...callData, status: "timeout" }, env.callTokenTtlSec);
            if (callData.endpointId) {
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
            try {
              const bridgeInfo = await getBridge(capturedBridgeId);
              if (bridgeInfo?.channels?.length) {
                for (const chId of bridgeInfo.channels) {
                  if (chId === channelId) continue;
                  try {
                    await hangupChannel(chId);
                  } catch (err) {
                    app.log.debug({ err, chId }, "Timed out: hangupChannel failed (channel may already be down)");
                  }
                }
              }
              await deleteBridge(capturedBridgeId);
              app.log.info({ bridgeId: capturedBridgeId }, "Timed out: bridge deleted");
            } catch (error) {
              app.log.debug({ err: error, bridgeId: capturedBridgeId }, "Bridge already deleted or delete failed");
            }
            if (callData.domophoneEndpointId) {
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
      try {
        const bridgeInfo = await getBridge(bridgeId);
        if (bridgeInfo?.channels?.length) {
          for (const chId of bridgeInfo.channels) {
            try {
              await hangupChannel(chId);
              app.log.info({ channelId: chId, bridgeId }, "StasisEnd: hung up channel in bridge");
            } catch (err) {
              app.log.debug({ err, channelId: chId }, "StasisEnd: channel already gone");
            }
          }
        }
        await deleteBridge(bridgeId);
        app.log.info({ bridgeId, channelId }, "StasisEnd: bridge deleted");
      } catch (error) {
        app.log.debug({ err: error, bridgeId, channelId }, "StasisEnd: bridge already deleted or cleanup failed");
      }
    } else {
      app.log.debug({ channelId }, "No bridgeId in channel session or call data, skipping bridge cleanup");
    }

    const callId = channelSession?.callId;
    if (callId && callData) {
      if (callData.status === "pending") {
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

      if (callData.status === "rejected") {
        app.log.debug({ callId }, "StasisEnd: skip FCM call-ended (user rejected)");
      } else if (callData.status === "accepted") {
        app.log.debug({ callId }, "StasisEnd: skip FCM call-ended (call was accepted, end via SIP only)");
      } else {
        const address = callData.address ?? "";
        const reason: "timeout" | "caller_hung_up" =
          callData.status === "timeout" ? "timeout" : "caller_hung_up";
        try {
          const userId = callData.userId ?? null;
          if (userId === null) {
            app.log.warn({ callId, domophoneEndpointId: callData.domophoneEndpointId, panelIp: callData.panelIp, apartment: callData.apartment }, "No user mapping for call-ended push, skipping push");
          } else {
            const tokens = await getPushTokens(userId);
            if (tokens.length > 0) {
            app.log.info({ callId, reason, tokensCount: tokens.length }, "Sending FCM call-ended push");
            const { invalidTokens } = await sendFcmCallEnded(tokens, { type: "SIP_CALL_ENDED", callId, address, reason });
            if (invalidTokens.length > 0) {
              await deletePushTokens(userId, invalidTokens);
              app.log.info({ callId, userId, removedCount: invalidTokens.length }, "Removed invalid FCM tokens from DB (call-ended)");
            }
            app.log.info({ callId }, "FCM call-ended push sent");
            }
          }
        } catch (error) {
          app.log.warn({ err: error, callId }, "Failed to send FCM call-ended push");
        }
      }
      if (callData.domophoneEndpointId) {
        await clearActiveIncomingFromPanel(callData.domophoneEndpointId);
      }
    }

    // Redis will cleanup session data automatically by TTL
  }
});

app.get("/health", async () => {
  return { ok: true, service: "intercom-backend", config: { baseUrl: config.baseUrl } };
});

/**
 * Cleanup temporary endpoints from PostgreSQL if Redis TTL expired.
 * Redis cleans up data automatically by TTL; here we only clean up PostgreSQL.
 */
const cleanupStaleEndpoints = async () => {
  try {
    const endpointIds = await getTempSipEndpoints();
    for (const endpointId of endpointIds) {
      const session = await getEndpointSession<{ type: "incoming" | "outgoing" }>(endpointId);
      if (!session) {
        try {
          await deleteTempSipEndpoint(endpointId);
          app.log.debug({ endpointId }, "Cleaned up stale endpoint from PostgreSQL");
        } catch (error) {
          app.log.warn({ err: error, endpointId }, "Failed to delete stale endpoint from PostgreSQL");
        }
        continue;
      }

      const callId = getCallIdByEndpointId(endpointId);
      if (!callId) continue;
      const callData = await getCallData<CallData>(callId);
      if (!callData) {
        try {
          await deleteTempSipEndpoint(endpointId);
          app.log.debug({ endpointId }, "Cleaned up endpoint after call data expired");
        } catch (error) {
          app.log.warn({ err: error, endpointId }, "Failed to delete endpoint from PostgreSQL");
        }
      }
    }
  } catch (error) {
    app.log.warn({ err: error }, "Failed to cleanup stale endpoints");
  }
};

setInterval(cleanupStaleEndpoints, 60000);

/**
 * Periodically check pending originate requests and try to originate calls.
 * This is a fallback mechanism in case EndpointStateChange events don't arrive in time.
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
        if (
          !pendingCallData ||
          pendingCallData.status !== "pending" ||
          pendingCallData.endpointId !== endpointId
        ) {
          await deletePendingOriginate(endpointId);
          app.log.info(
            {
              endpointId,
              callId: pendingCallId,
              status: pendingCallData?.status,
              actualEndpointId: pendingCallData?.endpointId,
            },
            "Dropped stale pending originate: call is no longer pending"
          );
          continue;
        }

        try {
          app.log.info(
            { endpointId, bridgeId: pending.bridgeId, time: Date.now() },
            "ATTEMPTING to originate call to endpoint"
          );
          const appArgs = `outgoing,${pending.bridgeId}`;
          await originateCall(`PJSIP/${endpointId}`, appArgs);
          await deletePendingOriginate(endpointId);
          app.log.info(
            { endpointId, bridgeId: pending.bridgeId, time: Date.now() },
            "SUCCESS: Originated call from periodic check"
          );
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

// Check every 2 seconds for pending originate requests
setInterval(checkPendingOriginate, 2000);

const protocol = httpsOptions ? "https" : "http";
app.log.info({ protocol, port: config.appPort, hasCertificates }, "Starting server");

app.listen({ port: config.appPort, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
