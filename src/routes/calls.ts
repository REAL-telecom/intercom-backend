import { FastifyInstance } from "fastify";
import { getCallToken } from "../store/redis";
import { createBridge, addChannelToBridge, originateCall } from "../ari/client";

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
};
