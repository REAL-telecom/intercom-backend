import { env } from "../config/env";

type ExpoMessage = {
  to: string;
  title?: string;
  body?: string;
  data?: Record<string, unknown>;
  sound?: "default" | null;
  priority?: "default" | "normal" | "high";
};

/**
 * Send push messages via Expo Push API.
 * EXPO_ACCESS_TOKEN is optional - if empty, sends without auth (lower reliability).
 */
export const sendExpoPush = async (messages: ExpoMessage[]) => {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (env.expoAccessToken) {
    headers.Authorization = `Bearer ${env.expoAccessToken}`;
  }

  const res = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers,
    body: JSON.stringify(messages),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Expo push failed: ${res.status} ${text}`);
  }

  return res.json();
};
