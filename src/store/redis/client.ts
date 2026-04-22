import Redis from "ioredis";
import { env } from "../../config/env";

const createRedis = () =>
  new Redis({
    host: env.redisHost,
    port: env.redisPort,
    password: env.redisPassword,
  });

/**
 * Shared Redis client for HTTP handlers, workers (non-blocking commands), and stores.
 */
export const redisClient = createRedis();

/**
 * Dedicated client for BLPOP in the OTP queue consumer. Blocking commands occupy their
 * connection until they return; using the same client as /auth would make every
 * request wait behind each BLPOP (multi-second tail latency in practice).
 */
export const redisBlockingClient = createRedis();
