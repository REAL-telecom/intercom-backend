import dotenv from "dotenv";

dotenv.config({ quiet: true });

const requireEnv = (key: string) => {
  const value = process.env[key];
  if (!value || value.length === 0) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
};

const parsePort = (value: string, defaultPort: number) => {
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? defaultPort : n;
};

export const env = {
  appPort: parsePort(process.env.SERVER_PORT ?? "3000", 3000),
  logLevel: process.env.LOG_LEVEL ?? "info",
  serverDomain: requireEnv("SERVER_DOMAIN"),
  serverIp: requireEnv("SERVER_IP"),
  ariHost: process.env.ARI_HOST ?? "127.0.0.1",
  ariPort: parsePort(process.env.ARI_PORT ?? "8088", 8088),
  ariUser: requireEnv("ARI_USER"),
  ariPassword: requireEnv("ARI_PASSWORD"),
  ariAppName: "intercom",
  // Outcome keys must outlive the call: if they expire first, panel hangup is treated as cancel and devices get a false missed-call push.
  // Overdue hangup lands up to one cleanup period late, so the margin covers maxCallDurationSec plus that period.
  callTokenTtlSec: 420,
  ringTimeoutSec: 15,
  maxCallDurationSec: 300,
  redisHost: process.env.REDIS_HOST ?? "127.0.0.1",
  redisPort: parsePort(process.env.REDIS_PORT ?? "6379", 6379),
  redisPassword: requireEnv("REDIS_PASSWORD"),
  postgres: {
    host: process.env.POSTGRES_HOST ?? "127.0.0.1",
    port: parsePort(process.env.POSTGRES_PORT ?? "5432", 5432),
    db: requireEnv("POSTGRES_DB"),
    user: requireEnv("POSTGRES_USER"),
    password: requireEnv("POSTGRES_PASSWORD"),
  },
  firebaseServiceAccountPath: process.env.FIREBASE_SERVICE_ACCOUNT_PATH || "",
  apns: {
    keyPath: process.env.APNS_KEY_PATH ?? "",
    keyId: process.env.APNS_KEY_ID ?? "",
    teamId: process.env.APNS_TEAM_ID ?? "",
    bundleId: process.env.APNS_BUNDLE_ID ?? "",
    environment: process.env.APNS_ENVIRONMENT ?? "",
  },
};
