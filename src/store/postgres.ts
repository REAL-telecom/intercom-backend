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
      max_contacts INTEGER,
      contact TEXT
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
      mailboxes TEXT,
      templates TEXT,
      direct_media TEXT,
      force_rport TEXT,
      rewrite_contact TEXT,
      rtp_symmetric TEXT
    );
  `);
  await pool.query(`
    ALTER TABLE ps_endpoints
    ADD COLUMN IF NOT EXISTS mailboxes TEXT;
  `);
  await pool.query(`
    ALTER TABLE ps_endpoints
    ADD COLUMN IF NOT EXISTS templates TEXT;
  `);
  await pool.query(`
    ALTER TABLE ps_aors
    ADD COLUMN IF NOT EXISTS contact TEXT;
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_tokens (
      id SERIAL PRIMARY KEY,
      user_id TEXT REFERENCES users(id),
      push_token TEXT NOT NULL,
      platform TEXT NOT NULL,
      device_id TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS push_tokens_unique
    ON push_tokens (user_id, push_token);
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS endpoint_addresses (
      endpoint_id TEXT PRIMARY KEY,
      address TEXT NOT NULL
    );
  `);
};

/**
 * Save (or update) push token (FCM) for a user.
 */
export const savePushToken = async (params: {
  userId: string;
  pushToken: string;
  platform: string;
  deviceId?: string;
}) => {
  const { userId, pushToken, platform, deviceId } = params;
  await pool.query(
    `
    INSERT INTO push_tokens (user_id, push_token, platform, device_id)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (user_id, push_token)
    DO UPDATE SET platform = EXCLUDED.platform, device_id = EXCLUDED.device_id, updated_at = NOW();
    `,
    [userId, pushToken, platform, deviceId ?? null]
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
 * Get display address for a PJSIP endpoint (e.g. doorphone). Used for FCM push subtitle.
 */
export const getAddressByEndpointId = async (endpointId: string): Promise<string | null> => {
  const result = await pool.query(
    `SELECT address FROM endpoint_addresses WHERE endpoint_id = $1`,
    [endpointId]
  );
  const row = result.rows[0] as { address: string } | undefined;
  return row?.address ?? null;
};

/**
 * Load all push tokens for a user.
 */
export const listPushTokens = async (userId: string) => {
  const result = await pool.query(
    `SELECT push_token FROM push_tokens WHERE user_id = $1`,
    [userId]
  );
  return result.rows.map((row: { push_token: string }) => row.push_token);
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
  templateId?: string;
}) => {
  const { id, username, password, context, templateId = "tpl_client" } = params;
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
      id, transport, aors, auth, context, templates, disallow, allow,
      direct_media, force_rport, rewrite_contact, rtp_symmetric
    ) VALUES (
      $1, 'transport-udp', $1, $1, $2, $3, 'all', 'ulaw,alaw,h264',
      'no', 'yes', 'yes', 'yes'
    )
    ON CONFLICT (id) DO UPDATE SET context = EXCLUDED.context, templates = EXCLUDED.templates, allow = EXCLUDED.allow;
    `,
    [id, context, templateId]
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

/**
 * List temporary SIP endpoints by prefix.
 */
export const listTempSipEndpoints = async () => {
  const result = await pool.query(
    `SELECT id FROM ps_endpoints WHERE id LIKE 'tmp_%' OR id LIKE 'out_%'`
  );
  return result.rows.map((row: { id: string }) => row.id);
};

/**
 * Ensure default PJSIP endpoint templates exist.
 */
export const ensurePjsipTemplates = async () => {
  await pool.query(
    `
    INSERT INTO ps_endpoints (
      id, transport, disallow, allow, direct_media, force_rport, rewrite_contact, rtp_symmetric
    ) VALUES (
      'tpl_domophone', 'transport-udp', 'all', 'ulaw,alaw,h264', 'no', 'yes', 'yes', 'yes'
    )
    ON CONFLICT (id) DO UPDATE SET allow = EXCLUDED.allow;
    `
  );
  await pool.query(
    `
    INSERT INTO ps_endpoints (
      id, transport, disallow, allow, direct_media, force_rport, rewrite_contact, rtp_symmetric
    ) VALUES (
      'tpl_client', 'transport-udp', 'all', 'ulaw,alaw,h264', 'no', 'yes', 'yes', 'yes'
    )
    ON CONFLICT (id) DO UPDATE SET allow = EXCLUDED.allow;
    `
  );
};

export const db = pool;
