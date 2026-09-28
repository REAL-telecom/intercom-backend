import * as fs from "fs";
import * as admin from "firebase-admin";
import { env } from "#config";

import type { FcmCallEndedPayload, FcmCallPayload } from "../types";

let initialized = false;

/** Missed-call ended push stays in FCM storage for one day (ms). */
const MISSED_CALL_TTL_MS = 86_400_000;

/**
 * Lazily initialize Firebase Admin SDK for FCM sending.
 */
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

type FcmAndroidOptions = {
  priority: "high" | "normal";
  ttl: number;
};

/**
 * Send FCM data message to multiple tokens. Returns tokens for which send failed
 * (caller removes them from DB). Does not throw on partial failure.
 */
async function sendFcm(
  tokens: string[],
  data: Record<string, string>,
  android: FcmAndroidOptions
): Promise<{ invalidTokens: string[] }> {
  const invalidTokens: string[] = [];
  if (tokens.length === 0) return { invalidTokens };
  ensureFirebase();
  const message = {
    tokens,
    data,
    android: {
      priority: android.priority,
      ttl: android.ttl,
    },
  };
  try {
    const batch = await admin.messaging().sendEachForMulticast(message);
    batch.responses.forEach((resp, i) => {
      if (!resp.success) {
        const token = tokens[i];
        if (token !== undefined) invalidTokens.push(token);
      }
    });
  } catch (err) {
    // Total failure (e.g. network): sendEachForMulticast threw before returning
    // per-token responses, so we have no invalidTokens to report — rethrow.
    throw err;
  }
  return { invalidTokens };
}

/**
 * Send data-only FCM messages to Android devices (incoming call).
 * ttl 0: do not queue if the device is offline at send time.
 * Returns invalid tokens to remove from DB. Does not throw on partial failure.
 */
export const sendFcmPush = async (
  tokens: string[],
  payload: FcmCallPayload
): Promise<{ invalidTokens: string[] }> => {
  const data: Record<string, string> = {
    type: payload.type,
    callId: payload.callId,
    sipCredentials: payload.sipCredentials,
    address: payload.address,
  };
  return sendFcm(tokens, data, { priority: "high", ttl: 0 });
};

/**
 * Send data-only FCM "call ended".
 * Missed (title+body): high priority, live one day. Silent: normal priority, ttl 0.
 * Returns invalid tokens to remove from DB. Does not throw on partial failure.
 */
export const sendFcmCallEnded = async (
  tokens: string[],
  payload: FcmCallEndedPayload
): Promise<{ invalidTokens: string[] }> => {
  const hasBanner =
    payload.title != null &&
    payload.title !== "" &&
    payload.body != null &&
    payload.body !== "";
  const data: Record<string, string> = {
    type: payload.type,
    callId: payload.callId,
    reason: payload.reason,
  };
  if (payload.address != null && payload.address !== "") {
    data.address = payload.address;
  }
  if (hasBanner) {
    data.title = payload.title!;
    data.body = payload.body!;
  }
  return sendFcm(tokens, data, {
    priority: hasBanner ? "high" : "normal",
    ttl: hasBanner ? MISSED_CALL_TTL_MS : 0,
  });
};
