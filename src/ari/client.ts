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
 * Build ARI REST base URL with basic auth.
 */
const buildBaseUrl = () => {
  const user = encodeURIComponent(env.ariUser);
  const pass = encodeURIComponent(env.ariPassword);
  return `http://${user}:${pass}@${env.ariHost}:${env.ariPort}/ari`;
};

/**
 * Build ARI WebSocket URL for events.
 */
const buildWsUrl = () => {
  const user = encodeURIComponent(env.ariUser);
  const pass = encodeURIComponent(env.ariPassword);
  return `ws://${user}:${pass}@${env.ariHost}:${env.ariPort}/ari/events?app=${env.ariAppName}`;
};

/**
 * Connect to ARI WebSocket events stream.
 */
export const connectAriEvents = (onEvent: AriEventHandler) => {
  const ws = new WebSocket(buildWsUrl());

  ws.on("message", (data: RawData) => {
    try {
      const event = JSON.parse(data.toString()) as AriEvent;
      onEvent(event);
    } catch {
      // ignore invalid payloads
    }
  });

  return ws;
};

/**
 * Perform ARI REST request.
 */
const request = async <T = unknown>(path: string, method = "GET", body?: unknown) => {
  const init: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
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
