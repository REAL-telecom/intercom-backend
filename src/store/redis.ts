import Redis from "ioredis";
import { env } from "../config/env";

const redis = new Redis({
  host: env.redisHost,
  port: env.redisPort,
  password: env.redisPassword,
});

/**
 * Store callToken payload with TTL.
 * Payload must include data needed to answer the call.
 */
export const setCallToken = async (callToken: string, payload: object, ttlSec: number) => {
  const key = `call:${callToken}`;
  await redis.set(key, JSON.stringify(payload), "EX", ttlSec);
};

/**
 * Load callToken payload from Redis.
 * Returns null when token is missing or expired.
 */
export const getCallToken = async <T>(callToken: string) => {
  const key = `call:${callToken}`;
  const value = await redis.get(key);
  return value ? (JSON.parse(value) as T) : null;
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
 * Store per-channel session info (endpointId, callToken).
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
