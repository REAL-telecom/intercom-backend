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
 * Remove callToken payload after call ends.
 */
export const deleteCallToken = async (callToken: string) => {
  const key = `call:${callToken}`;
  await redis.del(key);
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
 * Remove channel session after call end.
 */
export const deleteChannelSession = async (channelId: string) => {
  const key = `channel:${channelId}`;
  await redis.del(key);
};

export const redisClient = redis;
