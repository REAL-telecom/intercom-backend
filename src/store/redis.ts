import Redis from "ioredis";
import { env } from "../config/env";

const redis = new Redis({
  host: env.redisHost,
  port: env.redisPort,
  password: env.redisPassword,
});

/**
 * Store call data by callId with TTL.
 * Single entity for identifying a call; payload includes channelId, endpointId, credentials, etc.
 */
export const setCallData = async (callId: string, payload: object, ttlSec: number) => {
  const key = `call:${callId}`;
  await redis.set(key, JSON.stringify(payload), "EX", ttlSec);
};

/**
 * Load call data by callId.
 * Returns null when call is missing or expired.
 */
export const getCallData = async <T>(callId: string) => {
  const key = `call:${callId}`;
  const value = await redis.get(key);
  return value ? (JSON.parse(value) as T) : null;
};

/**
 * Derive callId from temporary endpoint id (inc_<callId> or out_<callId>).
 */
export const getCallIdFromEndpointId = (endpointId: string): string | null => {
  // Endpoint names are crafted by us; ARI adds a suffix after "-" for the channel name.
  // At this point we expect endpointId itself without that suffix.
  if (endpointId.startsWith("inc_") || endpointId.startsWith("out_")) {
    return endpointId.slice(4);
  }
  return null;
};

/**
 * Store temporary endpoint session mapping with TTL.
 */
export const setEndpointSession = async (
  endpointId: string,
  payload: object,
  ttlSec: number
) => {
  const key = `endpoint:${endpointId}`;
  await redis.set(key, JSON.stringify(payload), "EX", ttlSec);
};

/**
 * Load endpoint session mapping.
 */
export const getEndpointSession = async <T>(endpointId: string) => {
  const key = `endpoint:${endpointId}`;
  const value = await redis.get(key);
  return value ? (JSON.parse(value) as T) : null;
};

/**
 * Store per-channel session info (callId, endpointId, bridgeId, etc.).
 * Used for cleanup on StasisEnd.
 */
export const setChannelSession = async (
  channelId: string,
  payload: object,
  ttlSec: number
) => {
  const key = `channel:${channelId}`;
  await redis.set(key, JSON.stringify(payload), "EX", ttlSec);
};

/**
 * Load channel session info.
 */
export const getChannelSession = async <T>(channelId: string) => {
  const key = `channel:${channelId}`;
  const value = await redis.get(key);
  return value ? (JSON.parse(value) as T) : null;
};

/**
 * Store pending originate request for endpoint.
 * When endpoint becomes online, originate will be triggered.
 */
export const setPendingOriginate = async (
  endpointId: string,
  payload: { bridgeId: string; channelId: string },
  ttlSec: number
) => {
  const key = `originate:${endpointId}`;
  await redis.set(key, JSON.stringify(payload), "EX", ttlSec);
};

/**
 * Load pending originate request.
 */
export const getPendingOriginate = async <T>(endpointId: string) => {
  const key = `originate:${endpointId}`;
  const value = await redis.get(key);
  return value ? (JSON.parse(value) as T) : null;
};

/**
 * Remove pending originate after it's been processed.
 */
export const deletePendingOriginate = async (endpointId: string) => {
  const key = `originate:${endpointId}`;
  await redis.del(key);
};

/**
 * Active incoming call from a panel (domophone). Key: incoming_panel:${panelId} -> callId.
 * Sets only if key does not exist (atomic "claim"). Returns true if we claimed the panel, false if another call already has it.
 */
export const setActiveIncomingFromPanel = async (
  panelId: string,
  callId: string,
  ttlSec: number
): Promise<boolean> => {
  const key = `incoming_panel:${panelId}`;
  const result = await redis.set(key, callId, "EX", ttlSec, "NX");
  return result === "OK";
};

export const getActiveIncomingFromPanel = async (panelId: string): Promise<string | null> => {
  const key = `incoming_panel:${panelId}`;
  const value = await redis.get(key);
  return value;
};

export const clearActiveIncomingFromPanel = async (panelId: string) => {
  const key = `incoming_panel:${panelId}`;
  await redis.del(key);
};

export const redisClient = redis;
