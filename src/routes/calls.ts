import { FastifyInstance } from "fastify";
import crypto from "crypto";
import { env } from "../config/env";
import { setCallData, setEndpointSession, getCallData, clearActiveIncomingFromPanel } from "../store/redis";
import { createTempSipEndpoint } from "../store/postgres";
import { hangupChannel, deleteBridge, continueInDialplan, getBridge } from "../ari/client";

import type { CallData, CredentialsPayload } from "../types";

/**
 * Provide temporary SIP credentials for outgoing calls (client-to-client).
 * Uses callId as single entity; creates temp endpoint out_<callId>.
 */
export const registerCallRoutes = async (app: FastifyInstance) => {
  app.post("/calls/credentials", async () => {
    const callId = crypto.randomUUID();
    const endpointId = `out_${callId}`;
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

    await setCallData(callId, payload, env.callTokenTtlSec);
    await setEndpointSession(endpointId, { type: "outgoing" }, env.callTokenTtlSec);

    return payload.credentials.sipCredentials;
  });

  /**
   * End an incoming call (reject / decline from device).
   * Called by the app when user taps reject or when call is declined.
   * Hangs up the domophone channel and deletes the bridge.
   */
  app.post<{ Body: { callId: string } }>("/calls/end", async (request, reply) => {
    const callId = request.body?.callId?.trim();
    if (!callId) {
      return reply.code(400).send({ error: "callId required" });
    }
    const callData = await getCallData<CallData>(callId);
    if (!callData?.channelId) {
      return reply.code(404).send({ error: "Call not found or already ended" });
    }
    const channelId = callData.channelId;
    await setCallData(callId, { ...callData, status: "rejected" }, env.callTokenTtlSec);
    try {
      await continueInDialplan(channelId, "from-domophone", "busy", 1);
    } catch (err) {
      request.log.warn({ err, channelId, callId }, "continueInDialplan failed (channel may already be down)");
    }
    if (callData.bridgeId) {
      try {
        const bridgeInfo = await getBridge(callData.bridgeId);
        if (bridgeInfo?.channels?.length) {
          for (const chId of bridgeInfo.channels) {
            if (chId === channelId) continue;
            try {
              await hangupChannel(chId);
            } catch (err) {
              request.log.debug({ err, chId }, "hangupChannel failed (channel may already be down)");
            }
          }
        }
        await deleteBridge(callData.bridgeId);
      } catch (err) {
        request.log.debug({ err, bridgeId: callData.bridgeId }, "deleteBridge failed (bridge may already be gone)");
      }
    }
    if (callData.domophoneEndpointId) {
      await clearActiveIncomingFromPanel(callData.domophoneEndpointId);
    }
    return reply.code(204).send();
  });
};
