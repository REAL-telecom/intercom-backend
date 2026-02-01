import { FastifyInstance } from "fastify";
import { savePushToken } from "../store/postgres";

type RegisterBody = {
  userId: string;
  pushToken: string;
  platform: string;
  deviceId?: string;
};

/**
 * Push registration endpoint.
 * Stores FCM (or other) push token for a user.
 */
export const registerPushRoutes = async (app: FastifyInstance) => {
  app.post<{ Body: RegisterBody }>("/push/register", async (request) => {
    const { userId, pushToken, platform, deviceId } = request.body;
    if (!userId || !pushToken || !platform) {
      return app.httpErrors.badRequest("Missing required fields");
    }

    const payload = deviceId
      ? { userId, pushToken, platform, deviceId }
      : { userId, pushToken, platform };
    await savePushToken(payload);
    return { ok: true };
  });
};
