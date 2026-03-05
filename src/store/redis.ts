import Redis from "ioredis";
import { env } from "../config/env";

const redis = new Redis({
  host: env.redisHost,
  port: env.redisPort,
  password: env.redisPassword,
});

/**
 * Shape of data stored under call:${callId}.
 * Incoming (domophone): channelId, endpointId, credentials, status.
 * Outgoing (app-to-app): endpointId, credentials only.
 */
export interface CallData {
  channelId?: string;
  endpointId?: string;
  credentials?: {
    sipCredentials: {
      username: string;
      password: string;
      domain: string;
    };
  };
  /** For ring-timeout: only hang up if still 'pending'. Set to 'accepted' when answered, 'rejected' on /calls/end, 'timeout' when we hang up by timeout. */
  status?: "pending" | "accepted" | "rejected" | "timeout";
}

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
 * Derive callId from temporary endpoint id (tmp_<callId> or out_<callId>).
 */
export const getCallIdFromEndpointId = (endpointId: string): string | null => {
  if (endpointId.startsWith("tmp_") || endpointId.startsWith("out_")) {
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
 * Shape of data stored in channel session (StasisEnd cleanup, call-ended push).
 */
export interface ChannelSession {
  bridgeId?: string;
  endpointId?: string;
  callId?: string;
  address?: string;
}

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

export const redisClient = redis;
