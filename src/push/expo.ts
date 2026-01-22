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
 * Requires EXPO_ACCESS_TOKEN in env.
 */
export const sendExpoPush = async (messages: ExpoMessage[]) => {
  const res = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.expoAccessToken}`,
    },
    body: JSON.stringify(messages),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Expo push failed: ${res.status} ${text}`);
  }

  return res.json();
};
