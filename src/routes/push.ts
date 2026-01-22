import { FastifyInstance } from "fastify";
import { savePushToken } from "../store/postgres";

type RegisterBody = {
  userId: string;
  expoPushToken: string;
  platform: string;
  deviceId?: string;
};

/**
 * Push registration endpoint.
 * Stores Expo push token for a user.
 */
export const registerPushRoutes = async (app: FastifyInstance) => {
  app.post<{ Body: RegisterBody }>("/push/register", async (request) => {
    const { userId, expoPushToken, platform, deviceId } = request.body;
    if (!userId || !expoPushToken || !platform) {
      return app.httpErrors.badRequest("Missing required fields");
    }

    const payload = deviceId
      ? { userId, expoPushToken, platform, deviceId }
      : { userId, expoPushToken, platform };
    await savePushToken(payload);
    return { ok: true };
  });
};
