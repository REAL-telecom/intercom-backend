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
      console.warn("ARI WebSocket error", error);
    });

    ws.on("close", (code, reason) => {
      const reasonText = reason ? reason.toString() : "";
      const delayMs = Math.min(30000, 1000 * 2 ** Math.min(attempts, 5));
      attempts += 1;
      console.warn(
        `ARI WebSocket closed (code=${code}${reasonText ? `, reason=${reasonText}` : ""}); retry in ${delayMs}ms`
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
  return res.json() as Promise<T>;
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
 * Put incoming channel on hold while waiting for user.
 */
export const holdChannel = async (channelId: string) => {
  return request(`/channels/${channelId}/hold`, "POST");
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
