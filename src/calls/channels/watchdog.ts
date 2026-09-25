import { FastifyInstance } from "fastify";
import { env } from "../../config";
import { hangupChannel, listChannels } from "../../ari";

const parseAriTimestamp = (value: string | undefined): number | null => {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  // Asterisk Date strings use +0000 / -0600; Date.parse needs a colon in the offset.
  const normalized = value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? null : ms;
};

const isTemporaryEndpointChannel = (name: string | undefined): boolean => {
  const namePart = name?.split("/")[1];
  return Boolean(namePart && namePart.startsWith("tmp_"));
};

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
      if (!isTemporaryEndpointChannel(channel.name)) {
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
