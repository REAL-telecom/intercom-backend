import Fastify from "fastify";
import sensible from "@fastify/sensible";
import fs from "fs";
import { env } from "./config/env";
import { ensureSchema, ensureUser, ensurePjsipTemplates } from "./store/postgres";
import { registerPushRoutes } from "./routes/push";
import { registerCallRoutes } from "./routes/calls";
import {
  connectAriEvents,
  answerChannel,
  createBridge,
  addChannelToBridge,
  hangupChannel,
  subscribeToEndpointEvents,
  originateCall,
  getBridge,
} from "./ari/client";
import {
  listPushTokens,
  createTempSipEndpoint,
  deleteTempSipEndpoint,
  listTempSipEndpoints,
} from "./store/postgres";
import {
  setCallToken,
  setChannelSession,
  getChannelSession,
  setEndpointSession,
  getEndpointSession,
  getCallToken,
  setPendingOriginate,
  getPendingOriginate,
  deletePendingOriginate,
} from "./store/redis";
import { sendExpoPush } from "./push/expo";
import crypto from "crypto";

const config = {
  appPort: env.appPort,
  baseUrl: env.serverDomain,
};

// Проверяем наличие SSL сертификатов
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
  logger: true,
  ...(httpsOptions ? { https: httpsOptions } : {}),
});
app.register(sensible);

ensureSchema()
  .then(() => ensurePjsipTemplates())
  .then(() => ensureUser(env.realphone))
  .catch((error) => {
    app.log.error({ err: error }, "Failed to ensure database schema");
    process.exit(1);
  });

registerPushRoutes(app);
registerCallRoutes(app);

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
      // Log all endpoint fields
      app.log.info({ 
        endpointType: typeof ep,
        endpointKeys: Object.keys(ep),
        endpointFull: JSON.stringify(ep, null, 2),
        technology: (ep as any).technology,
        resource: (ep as any).resource,
        state: (ep as any).state,
        channel_ids: (ep as any).channel_ids,
        allFields: ep
      }, "EndpointStateChange - parsed endpoint with ALL fields");
      
      const endpoint = ep as { technology?: string; resource?: string; state?: string; channel_ids?: string[]; [key: string]: any };
      
      if (endpoint.technology === "PJSIP" && endpoint.resource?.startsWith("tmp_")) {
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

  if (event.type === "StasisStart" && typeof event.channel === "object" && event.channel) {
    app.log.info({ fullEvent: JSON.stringify(event) }, "StasisStart event - full data");
    const channel = event.channel as { id?: string };
    if (!channel.id) {
      app.log.warn({ event }, "StasisStart event without channel.id");
      return;
    }
    const channelId = channel.id;
    app.log.info({ channelId, channel: JSON.stringify(channel) }, "StasisStart - channel details");
    if (Array.isArray(event.args) && event.args[0] === "outgoing") {
      const bridgeId = String(event.args[1] ?? "");
      if (bridgeId) {
        try {
          app.log.info({ channelId, bridgeId }, "Processing outgoing channel - adding to bridge");
          
          // Даем каналу время инициализироваться
          await new Promise((r) => setTimeout(r, 200));
          
          // Добавляем канал в bridge
          await addChannelToBridge(bridgeId, channelId);
          app.log.info({ channelId, bridgeId }, "Outgoing channel successfully added to bridge");
          
          // Теперь нужно ответить на канал домофона
          // Получаем информацию о bridge, чтобы найти канал домофона
          try {
            // Даем время каналу клиента полностью инициализироваться
            await new Promise((r) => setTimeout(r, 300));
            
            const bridgeInfo = await getBridge(bridgeId);
            app.log.info({ bridgeId, channels: bridgeInfo.channels, currentChannel: channelId }, "Bridge info retrieved");
            
            if (bridgeInfo.channels && bridgeInfo.channels.length > 0) {
              // Находим канал домофона (не текущий outgoing канал)
              const domophoneChannelId = bridgeInfo.channels.find((ch: string) => ch !== channelId);
              if (domophoneChannelId) {
                app.log.info({ domophoneChannelId, bridgeId, allChannels: bridgeInfo.channels }, "Found domophone channel in bridge, answering it");
                try {
                  await answerChannel(domophoneChannelId);
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
          // Пытаемся еще раз через небольшую задержку
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
      // НЕ отвечаем сразу - ответим после того, как клиентский канал ответит
      // Это нужно для правильной установки соединения
      app.log.info({ channelId }, "Incoming domophone channel received, will answer after client connects");

      const callId = crypto.randomUUID();
      const callToken = crypto.randomUUID();
      const endpointId = `tmp_${callId}`;
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

      await setCallToken(
        callToken,
        {
          channelId,
          endpointId,
          credentials: {
            sipCredentials: {
              username: sipUsername,
              password: sipPassword,
              domain: env.serverDomain,
              port: 5060,
            },
          },
        },
        env.callTokenTtlSec
      );
      app.log.info({ callToken, channelId, endpointId, ttlSec: env.callTokenTtlSec }, "CallToken created and stored");
      await setEndpointSession(endpointId, { type: "call", token: callToken }, env.callTokenTtlSec);

      await setChannelSession(
        channelId,
        { callToken, endpointId },
        env.callTokenTtlSec
      );

      // Bridge and originate: same logic as previously in GET /calls/credentials
      try {
        app.log.info({ callToken, channelId, endpointId }, "STEP 1: Creating bridge and setting up originate");
        const bridge = await createBridge();
        app.log.info({ bridgeId: bridge.id, channelId }, "STEP 2: Bridge created, adding incoming domophone channel");
        await new Promise((r) => setTimeout(r, 300));
        await addChannelToBridge(bridge.id, channelId);
        app.log.info({ bridgeId: bridge.id, channelId }, "STEP 3: Incoming domophone channel added to bridge");
        await setPendingOriginate(endpointId, { bridgeId: bridge.id, channelId }, env.ringTimeoutSec);
        app.log.info({ endpointId, bridgeId: bridge.id }, "STEP 4: Pending originate stored, waiting for endpoint registration.");
      } catch (error) {
        app.log.error({ err: error, callToken, channelId, endpointId }, "CRITICAL: Failed to setup bridge/originate - call will not connect");
      }

      const tokens = await listPushTokens(env.realphone);
      app.log.info({ tokensCount: tokens.length, userId: env.realphone }, "Push tokens retrieved");
      if (tokens.length === 0) {
        app.log.warn("No push tokens for intercom user");
        return;
      }

      const sipCredentials = { username: sipUsername, password: sipPassword, domain: env.serverDomain, port: 5060 };
      app.log.info({ callId, tokensCount: tokens.length }, "Sending Expo push (call, data-only)");
      await sendExpoPush(
        tokens.map((token: string) => ({
          to: token,
          priority: "high",
          data: {
            type: "SIP_CALL",
            callId,
            sipCredentials: JSON.stringify(sipCredentials),
          },
        }))
      );
      app.log.info({ callId, tokensCount: tokens.length }, "Expo push (call) sent");

      // If nobody answers, auto-end the call on backend after ring timeout.
      void (async () => {
        try {
          await new Promise((r) => setTimeout(r, env.ringTimeoutSec * 1000));
          const stillActive = await getCallToken(callToken);
          if (!stillActive) {
            app.log.debug({ callToken, channelId }, "Call already ended, skipping timeout cleanup");
            return;
          }

          app.log.warn({ callToken, channelId, ringTimeoutSec: env.ringTimeoutSec, callTokenTtlSec: env.callTokenTtlSec }, "Incoming call timed out - hanging up channel");
          try {
            await hangupChannel(channelId);
            app.log.info({ callToken, channelId }, "Timed out channel hung up successfully - callToken will remain for cleanup");
          } catch (error) {
            app.log.warn({ err: error, callToken, channelId }, "Failed to hangup timed out channel");
          }
          // Не удаляем callToken сразу - даем время клиенту завершить звонок
          // Redis очистит его автоматически по TTL (который больше ringTimeoutSec)
          // callTokenTtlSec (300s) > ringTimeoutSec (60s), так что клиент успеет завершить звонок
        } catch (error) {
          app.log.warn({ err: error, callToken }, "Failed to auto-end timed out call");
        }
      })();
    } catch (error) {
      app.log.error({ err: error }, "Failed to handle StasisStart");
    }
  }

  if (event.type === "StasisEnd" && typeof event.channel === "object" && event.channel) {
    const channel = event.channel as { id?: string };
    if (!channel.id) return;
    // Не удаляем данные - Redis очистит их автоматически по TTL
    app.log.debug({ channelId: channel.id }, "StasisEnd - relying on Redis TTL for cleanup");
  }
});

app.get("/health", async () => {
  return { ok: true, service: "intercom-backend", config: { baseUrl: config.baseUrl } };
});

/**
 * Cleanup temporary endpoints from PostgreSQL if Redis TTL expired.
 * Redis очищает данные автоматически по TTL, здесь только очищаем PostgreSQL.
 */
const cleanupStaleEndpoints = async () => {
  try {
    const endpointIds = await listTempSipEndpoints();
    for (const endpointId of endpointIds) {
      const session = await getEndpointSession<{ type: "call" | "outgoing"; token: string }>(
        endpointId
      );
      // Если в Redis нет сессии, значит TTL истек - удаляем из PostgreSQL
      if (!session) {
        try {
          await deleteTempSipEndpoint(endpointId);
          app.log.debug({ endpointId }, "Cleaned up stale endpoint from PostgreSQL");
        } catch (error) {
          app.log.warn({ err: error, endpointId }, "Failed to delete stale endpoint from PostgreSQL");
        }
        continue;
      }

      // Проверяем, истек ли токен в Redis (call и outgoing используют callToken)
      const token = await getCallToken(session.token);
      if (!token) {
        try {
          await deleteTempSipEndpoint(endpointId);
          app.log.debug({ endpointId }, "Cleaned up endpoint after call token expired");
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
    const endpointIds = await listTempSipEndpoints();
    for (const endpointId of endpointIds) {
      const pending = await getPendingOriginate<{ bridgeId: string; channelId: string }>(
        endpointId
      );
      if (pending) {
        try {
          const appArgs = `outgoing,${pending.bridgeId}`;
          await originateCall(`PJSIP/${endpointId}`, appArgs);
          await deletePendingOriginate(endpointId);
          app.log.info({ endpointId, bridgeId: pending.bridgeId }, "Originated call from periodic check");
        } catch (error) {
          // Endpoint might not be registered yet, will retry on next check
          app.log.debug({ err: error, endpointId }, "Failed to originate from periodic check, will retry");
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
