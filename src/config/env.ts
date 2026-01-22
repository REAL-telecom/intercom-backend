import dotenv from "dotenv";

dotenv.config();

const requireEnv = (key: string) => {
  const value = process.env[key];
  if (!value || value.length === 0) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
};

export const env = {
  appPort: 3000,
  serverDomain: requireEnv("SERVER_DOMAIN"),
  serverIp: requireEnv("SERVER_IP"),
  ariHost: "127.0.0.1",
  ariPort: 8088,
  ariUser: requireEnv("ARI_USER"),
  ariPassword: requireEnv("ARI_PASSWORD"),
  ariAppName: "intercom",
  callTokenTtlSec: 15,
  ringTimeoutSec: 15,
  redisHost: "127.0.0.1",
  redisPort: 6379,
  redisPassword: requireEnv("REDIS_PASSWORD"),
  postgres: {
    host: "127.0.0.1",
    port: 5432,
    db: requireEnv("POSTGRES_DB"),
    user: requireEnv("POSTGRES_USER"),
    password: requireEnv("POSTGRES_PASSWORD"),
  },
  realphone: requireEnv("REALPHONE"),
  expoAccessToken: process.env.EXPO_ACCESS_TOKEN || "",
};
