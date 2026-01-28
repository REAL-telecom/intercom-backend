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
      // CallToken может быть уже удален (таймаут или завершение)
      // Это нормально - просто логируем и возвращаем успех
      app.log.debug({ callToken }, "CallToken not found - call may already be ended");
      throw app.httpErrors.notFound("Invalid callToken");
    }

    try {
      await hangupChannel(payload.channelId);
      app.log.info({ callToken, channelId: payload.channelId }, "Call ended successfully by token");
    } catch (error) {
      // Channel may already be gone; cleanup should still proceed.
      app.log.warn({ err: error, callToken, channelId: payload.channelId }, "Failed to hangup channel - may already be ended");
    }
    // Не удаляем данные - Redis очистит их автоматически по TTL
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
          app.log.info({ callToken, channelId: payload.channelId, endpointId: payload.endpointId }, "STEP 1: Creating bridge and setting up originate");
          
          // Создаем bridge с поддержкой видео
          const bridge = await createBridge();
          app.log.info({ bridgeId: bridge.id, channelId: payload.channelId }, "STEP 2: Bridge created, adding incoming domophone channel");
          
          // Даем каналу домофона время быть в состоянии Up
          await new Promise((r) => setTimeout(r, 300));
          
          // Добавляем канал домофона в bridge
          await addChannelToBridge(bridge.id, payload.channelId);
          app.log.info({ bridgeId: bridge.id, channelId: payload.channelId }, "STEP 3: Incoming domophone channel added to bridge");

          // Store pending originate - will be triggered when endpoint becomes online
          await setPendingOriginate(
            payload.endpointId,
            { bridgeId: bridge.id, channelId: payload.channelId },
            env.ringTimeoutSec
          );
          app.log.info({ endpointId: payload.endpointId, bridgeId: bridge.id }, "STEP 4: Pending originate stored, waiting for endpoint registration. When client registers, originate will be called and client channel will be added to bridge.");
        } catch (error) {
          app.log.error({ err: error, callToken, channelId: payload.channelId, endpointId: payload.endpointId }, "CRITICAL: Failed to setup bridge/originate - call will not connect");
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

      // Не удаляем данные - Redis очистит их автоматически по TTL
      // Удаляем только из PostgreSQL, если нужно
      try {
        await deleteTempSipEndpoint(payload.endpointId);
      } catch (error) {
        app.log.warn({ err: error, endpointId: payload.endpointId }, "Failed to delete endpoint from PostgreSQL");
      }
      return { ok: true };
    }
  );
};
