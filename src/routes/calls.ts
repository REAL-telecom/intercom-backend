import { FastifyInstance } from "fastify";
import crypto from "crypto";
import { env } from "../config/env";
import { setCallToken, setEndpointSession, getEndpointSession, getCallToken, getChannelSession } from "../store/redis";
import { createTempSipEndpoint } from "../store/postgres";
import { hangupChannel, deleteBridge } from "../ari/client";

type CredentialsPayload = {
  endpointId: string;
  credentials: {
    sipCredentials: {
      username: string;
      password: string;
      domain: string;
    };
  };
};

/**
 * Provide temporary SIP credentials for outgoing calls (client-to-client).
 * Creates callToken and temp endpoint; returns only credentials (no token to client).
 */
export const registerCallRoutes = async (app: FastifyInstance) => {
  app.post("/calls/credentials", async () => {
    const callToken = crypto.randomUUID();
    const endpointId = `out_${callToken}`;
    const sipUsername = endpointId;
    const sipPassword = crypto.randomBytes(8).toString("hex");

    await createTempSipEndpoint({
      id: endpointId,
      username: sipUsername,
      password: sipPassword,
      context: "intercom",
      templateId: "tpl_client",
    });

    const payload: CredentialsPayload = {
      endpointId,
      credentials: {
        sipCredentials: {
          username: sipUsername,
          password: sipPassword,
          domain: env.serverDomain,
        },
      },
    };

    await setCallToken(callToken, payload, env.callTokenTtlSec);
    await setEndpointSession(endpointId, { type: "outgoing", token: callToken }, env.callTokenTtlSec);

    return payload.credentials.sipCredentials;
  });

  /**
   * End an incoming call (reject / decline from device).
   * Called by the app when user taps reject or when call is declined.
   * Hangs up the domophone channel and deletes the bridge.
   */
  app.post<{ Body: { callId: string } }>("/calls/end", async (request, reply) => {
    const callId = request.body?.callId;
    if (!callId || typeof callId !== "string" || callId.trim() === "") {
      return reply.code(400).send({ error: "callId required" });
    }
    const endpointId = `tmp_${callId.trim()}`;
    const session = await getEndpointSession<{ type: string; token: string }>(endpointId);
    if (!session?.token) {
      return reply.code(404).send({ error: "Call not found or already ended" });
    }
    const tokenPayload = await getCallToken<{ channelId: string }>(session.token);
    if (!tokenPayload?.channelId) {
      return reply.code(404).send({ error: "Call not found or already ended" });
    }
    const channelId = tokenPayload.channelId;
    try {
      await hangupChannel(channelId);
    } catch (err) {
      request.log.warn({ err, channelId, callId }, "hangupChannel failed (channel may already be down)");
    }
    const channelSession = await getChannelSession<{ bridgeId?: string }>(channelId);
    if (channelSession?.bridgeId) {
      try {
        await deleteBridge(channelSession.bridgeId);
      } catch (err) {
        request.log.debug({ err, bridgeId: channelSession.bridgeId }, "deleteBridge failed (bridge may already be gone)");
      }
    }
    return reply.code(204).send();
  });
};
