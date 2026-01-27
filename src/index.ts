import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { env } from "./config/env";
import { ensureSchema, ensureUser, ensurePjsipTemplates } from "./store/postgres";
import { registerPushRoutes } from "./routes/push";
import { registerCallRoutes } from "./routes/calls";
import {
  connectAriEvents,
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

// Subscribe to endpoint events to receive EndpointStateChange
subscribeToEndpointEvents().catch((error) => {
  app.log.error({ err: error }, "Failed to subscribe to endpoint events");
});

connectAriEvents(async (event) => {
  // Handle endpoint registration - trigger originate when endpoint becomes online
  if (event.type === "EndpointStateChange") {
    // Log ALL EndpointStateChange events to debug
    app.log.info({ event: JSON.stringify(event) }, "EndpointStateChange event received");

    // Endpoint can be either string (resource ID) or object with resource/state
    let endpointId: string | null = null;
    let state: string | null = null;

    if (typeof event.endpoint === "string") {
      // Format: "PJSIP/endpointId" or just "endpointId"
      const match = event.endpoint.match(/^(?:PJSIP\/)?(.+)$/);
      if (match) {
        endpointId = match[1] ?? null;
      }
      state = (event as { endpoint_state?: string }).endpoint_state ?? null;
    } else if (typeof event.endpoint === "object" && event.endpoint) {
      const ep = event.endpoint as { resource?: string; state?: string; technology?: string };
      // resource already contains just the endpoint ID (e.g. "tmp_xxx"), not "PJSIP/tmp_xxx"
      if (ep.resource) {
        endpointId = ep.resource;
      }
      state = ep.state ?? null;
    }

    app.log.info({ endpointId, state }, "Parsed EndpointStateChange");

    if (endpointId && state === "online") {
      const pending = await getPendingOriginate<{ bridgeId: string; channelId: string }>(endpointId);
      if (pending) {
        try {
          const appArgs = `outgoing,${pending.bridgeId}`;
          await originateCall(`PJSIP/${endpointId}`, appArgs);
          await deletePendingOriginate(endpointId);
          app.log.info({ endpointId, bridgeId: pending.bridgeId }, "Originated call after endpoint registration");
        } catch (error) {
          app.log.warn({ err: error, endpointId }, "Failed to originate after endpoint registration");
        }
      }
    }
  }

  if (event.type === "StasisStart" && typeof event.channel === "object" && event.channel) {
    const channel = event.channel as { id?: string };
    if (!channel.id) return;
    const channelId = channel.id;
    if (Array.isArray(event.args) && event.args[0] === "outgoing") {
      const bridgeId = String(event.args[1] ?? "");
      if (bridgeId) {
        try {
          await addChannelToBridge(bridgeId, channelId);
        } catch (error) {
          app.log.warn({ err: error }, "Failed to add outgoing channel to bridge");
        }
      }
      return;
    }

    try {
      // A call can be cancelled very fast; HOLD may fail (404/409). Push should still be attempted.
      try {
        await holdChannel(channelId);
      } catch (error) {
        app.log.warn({ err: error }, "Failed to hold incoming channel");
      }

      const callId = crypto.randomUUID();
      const callToken = crypto.randomUUID();
      const endpointId = `tmp_${callId}`;
      const sipUsername = endpointId;
      const sipPassword = crypto.randomBytes(8).toString("hex");

      await createTempSipEndpoint({
        id: endpointId,
        username: sipUsername,
        password: sipPassword,
        context: "intercom",
        templateId: "tpl_client",
      });

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
      if (tokens.length === 0) {
        app.log.warn("No push tokens for intercom user");
        return;
      }

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

          await deleteTempSipEndpoint(endpointId);
          await deleteCallToken(callToken);
          await deleteChannelSession(channelId);
          await deleteEndpointSession(endpointId);
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
    try {
      const session = await getChannelSession<{ callToken: string; endpointId: string }>(
        channel.id
      );
      if (session) {
        await deleteTempSipEndpoint(session.endpointId);
        await deleteCallToken(session.callToken);
        await deleteChannelSession(channel.id);
        await deleteEndpointSession(session.endpointId);
      }
    } catch (error) {
      app.log.warn({ err: error }, "Failed to cleanup after StasisEnd");
    }
  }
});

app.get("/health", async () => {
  return { ok: true, service: "intercom-backend", config: { baseUrl: config.baseUrl } };
});

/**
 * Cleanup temporary endpoints without active tokens.
 */
const cleanupStaleEndpoints = async () => {
  try {
    const endpointIds = await listTempSipEndpoints();
    for (const endpointId of endpointIds) {
      const session = await getEndpointSession<{ type: "call" | "outgoing"; token: string }>(
        endpointId
      );
      if (!session) {
        await deleteTempSipEndpoint(endpointId);
        continue;
      }

      if (session.type === "call") {
        const token = await getCallToken(session.token);
        if (!token) {
          await deleteTempSipEndpoint(endpointId);
          await deleteEndpointSession(endpointId);
        }
      } else {
        const token = await getOutgoingToken(session.token);
        if (!token) {
          await deleteTempSipEndpoint(endpointId);
          await deleteEndpointSession(endpointId);
        }
      }
    }
  } catch (error) {
    app.log.warn({ err: error }, "Failed to cleanup stale endpoints");
  }
};

setInterval(cleanupStaleEndpoints, 60000);

app.listen({ port: config.appPort, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
