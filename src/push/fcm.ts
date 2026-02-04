import * as fs from "fs";
import * as admin from "firebase-admin";
import { env } from "../config/env";

let initialized = false;

function ensureFirebase() {
  if (initialized) return;
  const path = env.firebaseServiceAccountPath;
  if (!path) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT_PATH is required for FCM. Set it to the path of your Firebase service account JSON file."
    );
  }
  const serviceAccount = JSON.parse(
    fs.readFileSync(path, "utf8")
  ) as admin.ServiceAccount;
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  initialized = true;
}

export type FcmCallPayload = {
  type: "SIP_CALL";
  callId: string;
  sipCredentials: string;
  address?: string;
  /** Backend base URL for API calls (e.g. reject/end call). */
  backendUrl?: string;
};

/**
 * Send data-only FCM messages to Android devices (incoming call).
 * Uses flat data keys; high priority for immediate delivery.
 */
export const sendFcmPush = async (
  tokens: string[],
  payload: FcmCallPayload
): Promise<void> => {
  if (tokens.length === 0) return;
  ensureFirebase();
  const messaging = admin.messaging();
  const data: Record<string, string> = {
    type: payload.type,
    callId: payload.callId,
    sipCredentials: payload.sipCredentials,
  };
  if (payload.address != null && payload.address !== "") {
    data.address = payload.address;
  }
  if (payload.backendUrl != null && payload.backendUrl !== "") {
    data.backendUrl = payload.backendUrl;
  }
  const results = await Promise.allSettled(
    tokens.map((token) =>
      messaging.send({
        token,
        data,
        android: { priority: "high" as const },
      })
    )
  );
  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length > 0) {
    const first = (failed[0] as PromiseRejectedResult).reason;
    throw new Error(
      `FCM send failed for ${failed.length}/${tokens.length} tokens: ${first?.message ?? first}`
    );
  }
};
