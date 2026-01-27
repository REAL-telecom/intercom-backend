import { FastifyInstance } from "fastify";
import crypto from "crypto";
import { env } from "../config/env";
import {
  getCallToken,
  setOutgoingToken,
  getOutgoingToken,
  deleteOutgoingToken,
  setEndpointSession,
  getEndpointSession,
  deleteEndpointSession,
  deleteCallToken,
  deleteChannelSession,
} from "../store/redis";
import { createBridge, addChannelToBridge, originateCall, hangupChannel } from "../ari/client";
import { createTempSipEndpoint, deleteTempSipEndpoint } from "../store/postgres";
import { setPendingOriginate, deletePendingOriginate, getPendingOriginate } from "../store/redis";

type CallPayload = {
  channelId: string;
  endpointId: string;
  credentials: {
    sipCredentials: {
      username: string;
      password: string;
      domain: string;
      port: number;
    };
  };
};

type OutgoingPayload = {
  endpointId: string;
  credentials: {
    sipCredentials: {
      username: string;
      password: string;
      domain: string;
      port: number;
    };
  };
};

/**
 * Provide SIP credentials for the client by callToken.
 * Also creates bridge and originates outbound call.
 */
export const registerCallRoutes = async (app: FastifyInstance) => {
  const endCallByToken = async (callToken: string) => {
    const payload = await getCallToken<CallPayload>(callToken);
    if (!payload) {
      throw app.httpErrors.notFound("Invalid callToken");
    }

    try {
      await hangupChannel(payload.channelId);
    } catch (error) {
      // Channel may already be gone; cleanup should still proceed.
      app.log.warn({ err: error, callToken, channelId: payload.channelId }, "Failed to hangup channel");
    }

    // Удаляем токены и сессии сразу
    await deleteCallToken(callToken);
    await deleteChannelSession(payload.channelId);
    
    // Endpoint удаляем с задержкой - даем время для возможной повторной регистрации
    void (async () => {
      try {
        await new Promise((r) => setTimeout(r, 60000)); // 60 секунд задержка
        // Проверяем, что endpoint все еще не используется
        const stillExists = await getEndpointSession(payload.endpointId);
        if (stillExists) {
          const token = await getCallToken(callToken);
          if (!token) {
            // Токен удален, можно безопасно удалить endpoint
            await deleteTempSipEndpoint(payload.endpointId);
            await deleteEndpointSession(payload.endpointId);
          }
        }
      } catch (error) {
        app.log.warn({ err: error, endpointId: payload.endpointId }, "Failed to delayed cleanup endpoint");
      }
    })();
  };

  /**
   * End incoming call (hangup channel + cleanup temp endpoint + cleanup tokens).
   * Used by the mobile client on explicit reject/hangup.
   */
  app.post<{ Body: { callToken: string } }>("/calls/end", async (request) => {
    const { callToken } = request.body ?? {};
    if (!callToken) {
      return app.httpErrors.badRequest("Missing callToken");
    }

    await endCallByToken(callToken);

    return { ok: true };
  });

  // Backward-compatible alias for UI action naming.
  app.post<{ Body: { callToken: string } }>("/calls/reject", async (request) => {
    const { callToken } = request.body ?? {};
    if (!callToken) {
      return app.httpErrors.badRequest("Missing callToken");
    }
    await endCallByToken(callToken);
    return { ok: true };
  });

  app.get<{ Querystring: { callToken: string } }>(
    "/calls/credentials",
    async (request) => {
      const { callToken } = request.query;
      if (!callToken) {
        return app.httpErrors.badRequest("Missing callToken");
      }
      const payload = await getCallToken<CallPayload>(callToken);
      if (!payload) {
        return app.httpErrors.notFound("Invalid callToken");
      }

      // Return credentials immediately. Originate will be triggered when endpoint registers.
      const credentials = payload.credentials;

      void (async () => {
        try {
          const bridge = await createBridge();
          await addChannelToBridge(bridge.id, payload.channelId);

          // Store pending originate - will be triggered when endpoint becomes online
          await setPendingOriginate(
            payload.endpointId,
            { bridgeId: bridge.id, channelId: payload.channelId },
            env.ringTimeoutSec
          );
        } catch (error) {
          app.log.warn({ err: error, callToken }, "Failed to setup bridge/originate");
        }
      })();

      return credentials;
    }
  );

  /**
   * Provide temporary SIP credentials for outgoing calls.
   */
  app.post("/calls/outgoing-credentials", async () => {
    const outgoingToken = crypto.randomUUID();
    const endpointId = `out_${outgoingToken}`;
    const sipUsername = endpointId;
    const sipPassword = crypto.randomBytes(8).toString("hex");

    await createTempSipEndpoint({
      id: endpointId,
      username: sipUsername,
      password: sipPassword,
      context: "intercom",
      templateId: "tpl_client",
    });

    const payload: OutgoingPayload = {
      endpointId,
      credentials: {
        sipCredentials: {
          username: sipUsername,
          password: sipPassword,
          domain: env.serverDomain,
          port: 5060,
        },
      },
    };

    await setOutgoingToken(outgoingToken, payload, env.callTokenTtlSec);
    await setEndpointSession(endpointId, { type: "outgoing", token: outgoingToken }, env.callTokenTtlSec);

    return {
      outgoingToken,
      ...payload.credentials,
    };
  });

  /**
   * Cleanup temporary SIP endpoint for outgoing calls.
   */
  app.post<{ Body: { outgoingToken: string } }>(
    "/calls/outgoing-cleanup",
    async (request) => {
      const { outgoingToken } = request.body ?? {};
      if (!outgoingToken) {
        return app.httpErrors.badRequest("Missing outgoingToken");
      }

      const payload = await getOutgoingToken<OutgoingPayload>(outgoingToken);
      if (!payload) {
        return app.httpErrors.notFound("Invalid outgoingToken");
      }

      await deleteTempSipEndpoint(payload.endpointId);
      await deleteOutgoingToken(outgoingToken);
      await deleteEndpointSession(payload.endpointId);

      return { ok: true };
    }
  );
};
