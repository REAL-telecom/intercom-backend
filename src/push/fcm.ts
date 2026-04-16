import * as fs from "fs";
import * as admin from "firebase-admin";
import { env } from "../config/env";

import type { FcmCallPayload, FcmCallEndedPayload } from "../types";

let initialized = false;

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

/**
 * Send FCM data message to multiple tokens. Returns tokens for which send failed
 * (caller removes them from DB). Does not throw on partial failure.
 */
async function sendFcm(
  tokens: string[],
  data: Record<string, string>
): Promise<{ invalidTokens: string[] }> {
  const invalidTokens: string[] = [];
  if (tokens.length === 0) return { invalidTokens };
  ensureFirebase();
  const message = {
    tokens,
    data,
    android: { priority: "high" as const },
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
  };
  if (payload.address != null && payload.address !== "") {
    data.address = payload.address;
  }
  return sendFcm(tokens, data);
};

/**
 * Send data-only FCM "call ended". Returns invalid tokens to remove from DB.
 * reason is sent so the app can log it (only used when not rejected).
 */
export const sendFcmCallEnded = async (
  tokens: string[],
  payload: FcmCallEndedPayload
): Promise<{ invalidTokens: string[] }> => {
  const data: Record<string, string> = {
    type: "SIP_CALL_ENDED",
    callId: payload.callId,
    address: payload.address ?? "",
    reason: payload.reason,
  };
  return sendFcm(tokens, data);
};
