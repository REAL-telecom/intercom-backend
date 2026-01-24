import { FastifyInstance } from "fastify";
import crypto from "crypto";
import { env } from "../config/env";
import {
  getCallToken,
  setOutgoingToken,
  getOutgoingToken,
  deleteOutgoingToken,
  setEndpointSession,
  deleteEndpointSession,
} from "../store/redis";
import { createBridge, addChannelToBridge, originateCall } from "../ari/client";
import { createTempSipEndpoint, deleteTempSipEndpoint } from "../store/postgres";

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

      const bridge = await createBridge();
      await addChannelToBridge(bridge.id, payload.channelId);
      await originateCall(`PJSIP/${payload.endpointId}`, `outgoing,${bridge.id}`);

      return payload.credentials;
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
