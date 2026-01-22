import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { env } from "./config/env";
import { ensureSchema, ensureUser } from "./store/postgres";
import { registerPushRoutes } from "./routes/push";
import { registerCallRoutes } from "./routes/calls";
import { connectAriEvents, holdChannel, addChannelToBridge } from "./ari/client";
import { listPushTokens, createTempSipEndpoint, deleteTempSipEndpoint } from "./store/postgres";
import {
  setCallToken,
  setChannelSession,
  deleteCallToken,
  getChannelSession,
  deleteChannelSession,
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
  .then(() => ensureUser(env.realphone))
  .catch((error) => {
    app.log.error({ error }, "Failed to ensure database schema");
    process.exit(1);
  });

registerPushRoutes(app);
registerCallRoutes(app);

connectAriEvents(async (event) => {
  if (event.type === "StasisStart" && typeof event.channel === "object" && event.channel) {
    const channel = event.channel as { id?: string };
    if (!channel.id) return;
    if (Array.isArray(event.args) && event.args[0] === "outgoing") {
      const bridgeId = String(event.args[1] ?? "");
      if (bridgeId) {
        try {
          await addChannelToBridge(bridgeId, channel.id);
        } catch (error) {
          app.log.warn({ error }, "Failed to add outgoing channel to bridge");
        }
      }
      return;
    }

    try {
      await holdChannel(channel.id);

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
      });

      await setCallToken(
        callToken,
        {
          channelId: channel.id,
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

      await setChannelSession(
        channel.id,
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
          sound: "default",
          priority: "high",
        }))
      );
    } catch (error) {
      app.log.error({ error }, "Failed to handle StasisStart");
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
      }
    } catch (error) {
      app.log.warn({ error }, "Failed to cleanup after StasisEnd");
    }
  }
});

app.get("/health", async () => {
  return { ok: true, service: "intercom-backend", config: { baseUrl: config.baseUrl } };
});

app.listen({ port: config.appPort, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
