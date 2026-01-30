import { FastifyInstance } from "fastify";
import crypto from "crypto";
import { env } from "../config/env";
import { setCallToken, setEndpointSession } from "../store/redis";
import { createTempSipEndpoint } from "../store/postgres";

type CredentialsPayload = {
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
          port: 5060,
        },
      },
    };

    await setCallToken(callToken, payload, env.callTokenTtlSec);
    await setEndpointSession(endpointId, { type: "outgoing", token: callToken }, env.callTokenTtlSec);

    return payload.credentials.sipCredentials;
  });
};
