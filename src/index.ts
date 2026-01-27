import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { env } from "./config/env";
import { ensureSchema, ensureUser, ensurePjsipTemplates } from "./store/postgres";
import { registerPushRoutes } from "./routes/push";
import { registerCallRoutes } from "./routes/calls";
import {
  connectAriEvents,
  answerChannel,
  holdChannel,
  addChannelToBridge,
  hangupChannel,
  subscribeToEndpointEvents,
  originateCall,
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
  deleteCallToken,
  getChannelSession,
  deleteChannelSession,
  setEndpointSession,
  getEndpointSession,
  deleteEndpointSession,
  getCallToken,
  getOutgoingToken,
  getPendingOriginate,
  deletePendingOriginate,
} from "./store/redis";
import { sendExpoPush } from "./push/expo";
import crypto from "crypto";

const config = {
  appPort: env.appPort,
  baseUrl: env.serverDomain,
};

const app = Fastify({ logger: true });
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
          app.log.info({ endpointId, state, bridgeId: pending.bridgeId }, "Found pending originate, attempting to originate");
          // Try to originate regardless of state
          // If endpoint is registered, originate will succeed
          // If not, it will fail and we'll retry on next state change
          // This mimics how Linphone SDK works - it knows registration succeeded when it can use the endpoint
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
          app.log.info({ channelId, bridgeId }, "Outgoing channel successfully added to bridge - call should be connected");
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
      // Answer the incoming channel to move it from Ring to Up state
      // This is required for the call to be established properly
      try {
        await answerChannel(channelId);
        app.log.info({ channelId }, "Answered incoming channel");
        // Даем время каналу перейти в состояние Up
        await new Promise((r) => setTimeout(r, 100));
      } catch (error) {
        app.log.error({ err: error, channelId }, "Failed to answer incoming channel");
        return; // Не продолжаем, если не удалось ответить
      }

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
      await setEndpointSession(endpointId, { type: "call", token: callToken }, env.callTokenTtlSec);

      await setChannelSession(
        channelId,
        { callToken, endpointId },
        env.callTokenTtlSec
      );

      const tokens = await listPushTokens(env.realphone);
      app.log.info({ tokensCount: tokens.length, userId: env.realphone }, "Push tokens retrieved");
      if (tokens.length === 0) {
        app.log.warn("No push tokens for intercom user");
        return;
      }

      app.log.info({ callId, callToken, tokensCount: tokens.length }, "Sending Expo push notifications");
      await sendExpoPush(
        tokens.map((token: string) => ({
          to: token,
          title: "Звонок в домофон",
          body: "Кто-то стоит у двери",
          data: { type: "SIP_CALL", callId, callToken },
          // iOS: play bundled custom sound; Android: sound is controlled by notification channel.
          sound: "ringtone.wav",
          channelId: "calls",
          categoryId: "CALL",
          priority: "high",
        }))
      );
      app.log.info({ callId, callToken, tokensCount: tokens.length }, "Expo push notifications sent");

      // If nobody answers, auto-end the call on backend after ring timeout.
      void (async () => {
        try {
          await new Promise((r) => setTimeout(r, env.ringTimeoutSec * 1000));
          const stillActive = await getCallToken(callToken);
          if (!stillActive) return;

          app.log.warn({ callToken, channelId }, "Incoming call timed out");
          try {
            await hangupChannel(channelId);
          } catch (error) {
            app.log.warn({ err: error, callToken, channelId }, "Failed to hangup timed out channel");
          }
          // Не удаляем данные - Redis очистит их автоматически по TTL
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

      // Проверяем, истек ли токен в Redis
      if (session.type === "call") {
        const token = await getCallToken(session.token);
        if (!token) {
          // Токен истек в Redis - удаляем из PostgreSQL
          try {
            await deleteTempSipEndpoint(endpointId);
            app.log.debug({ endpointId }, "Cleaned up endpoint after call token expired");
          } catch (error) {
            app.log.warn({ err: error, endpointId }, "Failed to delete endpoint from PostgreSQL");
          }
        }
      } else {
        const token = await getOutgoingToken(session.token);
        if (!token) {
          // Токен истек в Redis - удаляем из PostgreSQL
          try {
            await deleteTempSipEndpoint(endpointId);
            app.log.debug({ endpointId }, "Cleaned up endpoint after outgoing token expired");
          } catch (error) {
            app.log.warn({ err: error, endpointId }, "Failed to delete endpoint from PostgreSQL");
          }
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

app.listen({ port: config.appPort, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
