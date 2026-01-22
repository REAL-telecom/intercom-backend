import { Pool } from "pg";
import { env } from "../config/env";

const pool = new Pool({
  host: env.postgres.host,
  port: env.postgres.port,
  database: env.postgres.db,
  user: env.postgres.user,
  password: env.postgres.password,
});

/**
 * Ensure core schema for users, calls, push tokens and PJSIP realtime tables.
 * Runs once at startup to make server self-contained.
 */
export const ensureSchema = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      phone TEXT UNIQUE,
      is_active BOOLEAN DEFAULT FALSE,
      paid_until DATE,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS calls (
      id SERIAL PRIMARY KEY,
      user_id TEXT REFERENCES users(id),
      call_id TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TIMESTAMP DEFAULT NOW(),
      ended_at TIMESTAMP,
      -- optional: store preview URL for paid history feature
      preview_url TEXT,
      door_opened BOOLEAN DEFAULT FALSE
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ps_aors (
      id TEXT PRIMARY KEY,
      max_contacts INTEGER
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ps_auths (
      id TEXT PRIMARY KEY,
      auth_type TEXT,
      username TEXT,
      password TEXT
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ps_endpoints (
      id TEXT PRIMARY KEY,
      transport TEXT,
      aors TEXT,
      auth TEXT,
      context TEXT,
      disallow TEXT,
      allow TEXT,
      direct_media TEXT,
      force_rport TEXT,
      rewrite_contact TEXT,
      rtp_symmetric TEXT
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_tokens (
      id SERIAL PRIMARY KEY,
      user_id TEXT REFERENCES users(id),
      expo_push_token TEXT NOT NULL,
      platform TEXT NOT NULL,
      device_id TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS push_tokens_unique
    ON push_tokens (user_id, expo_push_token);
  `);
};

/**
 * Save (or update) Expo push token for a user.
 */
export const savePushToken = async (params: {
  userId: string;
  expoPushToken: string;
  platform: string;
  deviceId?: string;
}) => {
  const { userId, expoPushToken, platform, deviceId } = params;
  await pool.query(
    `
    INSERT INTO push_tokens (user_id, expo_push_token, platform, device_id)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (user_id, expo_push_token)
    DO UPDATE SET platform = EXCLUDED.platform, device_id = EXCLUDED.device_id, updated_at = NOW();
    `,
    [userId, expoPushToken, platform, deviceId ?? null]
  );
};

/**
 * Ensure user record exists (TEXT id).
 * Used for MVP single-user setup.
 */
export const ensureUser = async (userId: string) => {
  await pool.query(
    `
    INSERT INTO users (id)
    VALUES ($1)
    ON CONFLICT (id) DO NOTHING;
    `,
    [userId]
  );
};

/**
 * Load all Expo tokens for a user.
 */
export const listPushTokens = async (userId: string) => {
  const result = await pool.query(
    `SELECT expo_push_token FROM push_tokens WHERE user_id = $1`,
    [userId]
  );
  return result.rows.map((row) => row.expo_push_token as string);
};

/**
 * Create a temporary PJSIP endpoint in realtime tables.
 * This endpoint is removed after the call ends.
 */
export const createTempSipEndpoint = async (params: {
  id: string;
  username: string;
  password: string;
  context: string;
}) => {
  const { id, username, password, context } = params;
  await pool.query(
    `
    INSERT INTO ps_aors (id, max_contacts)
    VALUES ($1, 1)
    ON CONFLICT (id) DO UPDATE SET max_contacts = 1;
    `,
    [id]
  );
  await pool.query(
    `
    INSERT INTO ps_auths (id, auth_type, username, password)
    VALUES ($1, 'userpass', $2, $3)
    ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username, password = EXCLUDED.password;
    `,
    [id, username, password]
  );
  await pool.query(
    `
    INSERT INTO ps_endpoints (
      id, transport, aors, auth, context, disallow, allow,
      direct_media, force_rport, rewrite_contact, rtp_symmetric
    ) VALUES (
      $1, 'transport-udp', $1, $1, $2, 'all', 'ulaw,alaw',
      'no', 'yes', 'yes', 'yes'
    )
    ON CONFLICT (id) DO UPDATE SET context = EXCLUDED.context;
    `,
    [id, context]
  );
};

/**
 * Remove temporary PJSIP endpoint from realtime tables.
 */
export const deleteTempSipEndpoint = async (id: string) => {
  await pool.query(`DELETE FROM ps_endpoints WHERE id = $1`, [id]);
  await pool.query(`DELETE FROM ps_auths WHERE id = $1`, [id]);
  await pool.query(`DELETE FROM ps_aors WHERE id = $1`, [id]);
};

export const db = pool;
