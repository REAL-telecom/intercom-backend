import { FastifyInstance } from "fastify";
import { savePushToken } from "#store/postgres";

import type { RegisterBody } from "../types";

/**
 * Accept JSON number or numeric string from older Android builds.
 */
const parseRegisterUserId = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) {
      const parsed = Number(trimmed);
      if (Number.isSafeInteger(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }
  return null;
};

/**
 * Push registration endpoint.
 * Stores FCM (or other) push token for a user.
 */
export const registerPushRoutes = async (app: FastifyInstance) => {
  app.post<{ Body: RegisterBody }>("/push/register", async (request) => {
    const { userId: rawUserId, pushToken, platform } = request.body;
    const userId = parseRegisterUserId(rawUserId);
    if (userId === null || !pushToken || (platform !== "android" && platform !== "ios_voip" && platform !== "ios_apns")) {
      return app.httpErrors.badRequest("Missing required fields");
    }

    await savePushToken({ userId, pushToken, platform });
    return { ok: true };
  });
};
