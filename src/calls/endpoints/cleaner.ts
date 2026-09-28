import { FastifyInstance } from "fastify";
import { deletePhoneEndpoint } from "./endpoint";
import { listPhoneEndpoints } from "#store/postgres";
import { getCall, getEndpoint } from "#store/redis";

/**
 * Cleanup temporary endpoints if Redis TTL expired.
 * Redis cleans up data automatically by TTL; here we remove leftover Postgres rows and ARI objects.
 */
export const cleanupStaleEndpoints = async (app: FastifyInstance) => {
  try {
    const endpointIds = await listPhoneEndpoints();
    for (const endpointId of endpointIds) {
      const endpoint = await getEndpoint(endpointId);
      const call = endpoint ? await getCall(endpoint.callId) : null;
      if (endpoint && call) {
        continue;
      }

      await deletePhoneEndpoint(endpointId, { callId: endpoint?.callId, reason: "ttl-expired" }, app);
    }
  } catch (error) {
    app.log.warn({ err: error }, "Cleanup: failed to cleanup stale endpoints");
  }
};
