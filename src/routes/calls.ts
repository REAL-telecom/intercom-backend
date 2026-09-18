import { FastifyInstance } from "fastify";
import crypto from "crypto";
import { env } from "../config/env";
import {
  setCallData,
  setEndpointSession,
  getCallData,
  claimCallOutcome,
  getOriginateChannelIds,
  clearActiveIncomingFromPanel,
  deletePendingOriginate,
} from "../store/redis";
import { createTempSipEndpoint } from "../store/postgres";
import { hangupChannelIfExists, continueInDialplan } from "../ari/client";
import { teardownBridge } from "../calls/teardown";
import { notifyCallOver } from "../push/notifyCallOver";

import type { CallData, CredentialsPayload } from "../types";

/**
 * Register call routes:
 * - issue temporary SIP credentials for outgoing client calls (`/calls/credentials`)
 * - terminate active incoming call flow and cleanup bridge/channels (`/calls/end`)
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
    const claimed = await claimCallOutcome(callId, "rejected", env.callTokenTtlSec);
    request.log.info({ callId, claimed }, "calls/end: claimed rejected outcome");
    if (claimed) {
      await notifyCallOver(callId, callData, "declined_elsewhere", request.log);
    }
    if (callData.endpointId) {
      try {
        await deletePendingOriginate(callData.endpointId);
        request.log.info(
          { callId, endpointId: callData.endpointId },
          "calls/end: cleared pending originate"
        );
      } catch (err) {
        request.log.warn(
          { err, callId, endpointId: callData.endpointId },
          "calls/end: failed to clear pending originate"
        );
      }
    }
    try {
      await continueInDialplan(channelId, "from-domophone", "busy", 1);
    } catch (err) {
      request.log.warn({ err, channelId, callId }, "continueInDialplan failed (channel may already be down)");
    }
    const originateChannelIds = await getOriginateChannelIds(callId);
    for (const originateChannelId of originateChannelIds) {
      if ((await hangupChannelIfExists(originateChannelId)) === "hung_up") {
        request.log.info(
          { callId, originateChannelId },
          "calls/end: hung up originate channel"
        );
      }
    }
    if (callData.bridgeId) {
      await teardownBridge(
        callData.bridgeId,
        channelId,
        { callId, channelId, source: "callsEnd" },
        request.log
      );
    }
    if (callData.domophoneEndpointId) {
      await clearActiveIncomingFromPanel(callData.domophoneEndpointId);
    }
    return reply.code(204).send();
  });
};
