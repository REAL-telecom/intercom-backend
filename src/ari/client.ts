import WebSocket, { RawData } from "ws";
import { env } from "../config/env";

type AriEvent = {
  type: string;
  [key: string]: unknown;
};

type AriEventHandler = (event: AriEvent) => void;

type AriBridge = {
  id: string;
};

/**
 * Build ARI REST base URL (no credentials in URL).
 */
const buildBaseUrl = () => {
  return `http://${env.ariHost}:${env.ariPort}/ari`;
};

/**
 * Build ARI WebSocket URL for events (no credentials in URL).
 */
const buildWsUrl = () => {
  return `ws://${env.ariHost}:${env.ariPort}/ari/events?app=${env.ariAppName}`;
};

const buildAuthHeader = () => {
  const token = Buffer.from(`${env.ariUser}:${env.ariPassword}`).toString("base64");
  return `Basic ${token}`;
};

/**
 * Connect to ARI WebSocket events stream.
 */
export const connectAriEvents = (onEvent: AriEventHandler) => {
  let attempts = 0;
  let current: WebSocket | null = null;

  const connect = () => {
    const ws = new WebSocket(buildWsUrl(), {
      headers: {
        Authorization: buildAuthHeader(),
      },
    });
    current = ws;

    ws.on("open", () => {
      attempts = 0;
      console.log("✅ ARI WebSocket connected successfully");
    });

    ws.on("message", (data: RawData) => {
      try {
        const event = JSON.parse(data.toString()) as AriEvent;
        onEvent(event);
      } catch {
        // ignore invalid payloads
      }
    });

    ws.on("error", (error) => {
      console.error("❌ ARI WebSocket error", error);
    });

    ws.on("close", (code, reason) => {
      const reasonText = reason ? reason.toString() : "";
      const delayMs = Math.min(30000, 1000 * 2 ** Math.min(attempts, 5));
      attempts += 1;
      console.warn(
        `⚠️ ARI WebSocket closed (code=${code}${reasonText ? `, reason=${reasonText}` : ""}); retry in ${delayMs}ms`
      );
      setTimeout(connect, delayMs);
    });

    return ws;
  };

  return connect() ?? current!;
};

/**
 * Perform ARI REST request.
 */
const request = async <T = unknown>(path: string, method = "GET", body?: unknown) => {
  const init: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: buildAuthHeader(),
    },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${buildBaseUrl()}${path}`, init);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ARI request failed: ${res.status} ${text}`);
  }

  // Many ARI endpoints (e.g. /channels/{id}/hold) return 204 No Content.
  if (res.status === 204) {
    return undefined as T;
  }

  const text = await res.text();
  if (!text) {
    return undefined as T;
  }

  // Prefer JSON parsing when possible, but don't assume every successful response has JSON.
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
};

/**
 * Create mixing bridge for call.
 */
export const createBridge = async () => {
  return request<AriBridge>("/bridges", "POST", { type: "mixing" });
};

/**
 * Add channel to existing bridge.
 */
export const addChannelToBridge = async (bridgeId: string, channelId: string) => {
  return request(`/bridges/${bridgeId}/addChannel`, "POST", { channel: channelId });
};

/**
 * Answer incoming channel (move from Ring to Up state).
 */
export const answerChannel = async (channelId: string) => {
  return request(`/channels/${channelId}/answer`, "POST");
};

/**
 * Put incoming channel on hold while waiting for user.
 */
export const holdChannel = async (channelId: string) => {
  return request(`/channels/${channelId}/hold`, "POST");
};

/**
 * Hangup channel (terminate call).
 */
export const hangupChannel = async (channelId: string) => {
  return request(`/channels/${channelId}`, "DELETE");
};

/**
 * Originate outgoing call to endpoint.
 * appArgs may include metadata (e.g. bridge id).
 */
export const originateCall = async (endpoint: string, appArgs: string) => {
  return request("/channels", "POST", {
    endpoint,
    app: env.ariAppName,
    appArgs,
  });
};

/**
 * Delete bridge when call ends.
 */
export const deleteBridge = async (bridgeId: string) => {
  return request(`/bridges/${bridgeId}`, "DELETE");
};

/**
 * Get endpoint status (online/offline/unknown).
 */
export const getEndpointStatus = async (tech: string, resource: string) => {
  return request<{ technology: string; resource: string; state: string; channel_ids: string[] }>(
    `/endpoints/${tech}/${resource}`
  );
};

/**
 * Subscribe ARI application to endpoint events.
 * Required to receive EndpointStateChange events.
 * Subscribes to all PJSIP endpoints.
 */
export const subscribeToEndpointEvents = async () => {
  // Subscribe to all PJSIP endpoints using query parameter
  const res = await fetch(
    `${buildBaseUrl()}/applications/${env.ariAppName}/subscription?eventSource=endpoint:PJSIP`,
    {
      method: "POST",
      headers: {
        Authorization: buildAuthHeader(),
      },
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to subscribe to endpoint events: ${res.status} ${text}`);
  }
  return undefined;
};
