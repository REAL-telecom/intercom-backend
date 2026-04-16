import Redis from "ioredis";
import { env } from "../../config/env";

/**
 * Shared Redis client for all backend stores.
 */
export const redisClient = new Redis({
  host: env.redisHost,
  port: env.redisPort,
  password: env.redisPassword,
});
