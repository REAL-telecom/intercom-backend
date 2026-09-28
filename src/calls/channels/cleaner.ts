import { FastifyInstance } from "fastify";
import { env } from "#config";
import { hangupChannel, listChannels } from "#ari";
import { parseAriTimestamp, parsePjsipId } from "../parsers";
import { getEndpoint } from "#store/redis";

async function isPhoneChannel(name: string | undefined): Promise<boolean> {
  const pjsipId = parsePjsipId(name);
  if (!pjsipId) {
    return false;
  }
  const endpoint = await getEndpoint(pjsipId);
  return endpoint?.type === "phone";
}

/**
 * Hang up leftover temp-endpoint channels older than maxCallDurationSec.
 * Age-only: a live bridged talk past the limit is hung up too.
 */
export const cleanupStaleChannels = async (app: FastifyInstance) => {
  try {
    const channels = await listChannels();
    const maxAgeMs = env.maxCallDurationSec * 1000;
    const now = Date.now();
    for (const channel of channels) {
      if (!(await isPhoneChannel(channel.name))) {
        continue;
      }
      const createdAtMs = parseAriTimestamp(channel.creationtime);
      if (createdAtMs === null) {
        app.log.warn(
          { channelId: channel.id, name: channel.name, creationtime: channel.creationtime },
          "Cleanup: skipped overdue hangup, could not parse channel creationtime"
        );
        continue;
      }
      const ageMs = now - createdAtMs;
      if (ageMs <= maxAgeMs) {
        continue;
      }
      app.log.warn(
        { channelId: channel.id, name: channel.name, ageSec: Math.floor(ageMs / 1000) },
        "Cleanup: hanging up overdue channel"
      );
      await hangupChannel(channel.id, app.log);
    }
  } catch (error) {
    app.log.warn({ err: error }, "Cleanup: failed to hang up overdue channels");
  }
};
