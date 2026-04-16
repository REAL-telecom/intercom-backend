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
export const createDatabaseSchema = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS addresses (
      id BIGSERIAL PRIMARY KEY,
      street TEXT NOT NULL,
      house TEXT NOT NULL,
      building TEXT,
      letter TEXT,
      structure TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS panels (
      id BIGSERIAL PRIMARY KEY,
      ip INET UNIQUE NOT NULL,
      address_id BIGINT NOT NULL REFERENCES addresses(id),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      phone TEXT UNIQUE,
      is_active BOOLEAN DEFAULT FALSE,
      paid_until DATE,
      address_id BIGINT REFERENCES addresses(id),
      apartment TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      last_verified_at TIMESTAMPTZ
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS calls (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
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
      password TEXT,
      realm TEXT
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
      rtp_symmetric TEXT,
      ice_support TEXT,
      outbound_auth TEXT,
      from_user TEXT,
      from_domain TEXT,
      callerid TEXT
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ps_registrations (
      id TEXT PRIMARY KEY,
      auth_rejection_permanent TEXT,
      client_uri TEXT,
      contact_user TEXT,
      expiration INTEGER,
      fatal_retry_interval INTEGER,
      forbidden_retry_interval INTEGER,
      max_retries INTEGER,
      outbound_auth TEXT,
      outbound_proxy TEXT,
      retry_interval INTEGER,
      server_uri TEXT,
      transport TEXT,
      support_path TEXT,
      support_outbound_authentication TEXT
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_tokens (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      push_token TEXT NOT NULL,
      platform TEXT NOT NULL,
      device_id TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (user_id, push_token)
    );
  `);
};

/**
 * Save (or update) push token (FCM) for a user.
 */
export const savePushToken = async (params: {
  userId: number;
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

export type AddressRecord = {
  id: number;
  street: string;
  house: string;
  building: string | null;
  letter: string | null;
  structure: string | null;
};

/**
 * Create an address row and return stored canonical fields.
 * Optional parts are persisted as NULL when omitted.
 */
export const addAddress = async (params: {
  street: string;
  house: string;
  building?: string;
  letter?: string;
  structure?: string;
}): Promise<AddressRecord> => {
  const { street, house, building, letter, structure } = params;
  const result = await pool.query<AddressRecord>(
    `
    INSERT INTO addresses (street, house, building, letter, structure, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
    RETURNING id, street, house, building, letter, structure
    `,
    [street, house, building ?? null, letter ?? null, structure ?? null]
  );
  const row = result.rows[0];
  if (!row) throw new Error("Failed to create address");
  return row;
};

export type PanelRecord = {
  id: number;
  ip: string;
  address_id: number;
};

/**
 * Create panel mapping (IP -> address) and return inserted row.
 * IP is stored as inet and returned as text.
 */
export const addPanel = async (params: {
  ip: string;
  addressId: number;
}): Promise<PanelRecord> => {
  const { ip, addressId } = params;
  const result = await pool.query<PanelRecord>(
    `
    INSERT INTO panels (ip, address_id, created_at, updated_at)
    VALUES ($1::inet, $2, NOW(), NOW())
    RETURNING id, ip::text AS ip, address_id
    `,
    [ip, addressId]
  );
  const row = result.rows[0];
  if (!row) throw new Error("Failed to create panel");
  return row;
};

/**
 * Find panel by IP address.
 * Returns null when no panel exists for this IP.
 */
export const getPanel = async (ip: string): Promise<PanelRecord | null> => {
  const result = await pool.query<PanelRecord>(
    `
    SELECT id, ip::text AS ip, address_id
    FROM panels
    WHERE ip = $1::inet
    LIMIT 1
    `,
    [ip]
  );
  return result.rows[0] ?? null;
};

export type UserByAddressApartment = {
  id: number;
  phone: string;
};

/**
 * Lookup user by address and apartment pair.
 * Returns null when no matching user is found.
 */
export const getUser = async (
  addressId: number,
  apartment: string
): Promise<UserByAddressApartment | null> => {
  const result = await pool.query<UserByAddressApartment>(
    `
    SELECT id, phone
    FROM users
    WHERE address_id = $1 AND apartment = $2
    LIMIT 1
    `,
    [addressId, apartment]
  );
  return result.rows[0] ?? null;
};

/**
 * Load all push tokens for a user.
 */
export const getPushTokens = async (userId: number | string) => {
  const result = await pool.query(
    `SELECT push_token FROM push_tokens WHERE user_id = $1`,
    [userId]
  );
  return result.rows.map((row: { push_token: string }) => row.push_token);
};

/**
 * Remove push tokens that FCM reported as invalid (e.g. app uninstalled, token expired).
 */
export const deletePushTokens = async (userId: number | string, tokens: string[]) => {
  if (tokens.length === 0) return;
  await pool.query(
    `DELETE FROM push_tokens WHERE user_id = $1 AND push_token = ANY($2::text[])`,
    [userId, tokens]
  );
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
      direct_media, force_rport, rewrite_contact, rtp_symmetric, ice_support
    ) VALUES (
      $1, 'transport-udp', $1, $1, $2, $3, 'all', 'ulaw,alaw,h264',
      'no', 'yes', 'yes', 'yes', 'yes'
    )
    ON CONFLICT (id) DO UPDATE SET context = EXCLUDED.context, templates = EXCLUDED.templates, allow = EXCLUDED.allow, ice_support = EXCLUDED.ice_support;
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
export const getTempSipEndpoints = async () => {
  const result = await pool.query(
    `SELECT id FROM ps_endpoints WHERE id LIKE 'inc_%' OR id LIKE 'out_%'`
  );
  return result.rows.map((row: { id: string }) => row.id);
};

/**
 * Ensure default PJSIP endpoint templates exist.
 */
export const sipEndpointTemplates = async () => {
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

/**
 * New user row after successful phone verification (other columns default).
 */
export type User = {
  id: number;
  phone: string;
  pushToken: string | null;
};

/**
 * Ensure user exists for verified phone and return app auth payload.
 * Reuses existing user if phone was already verified earlier.
 */
export const getOrCreateUser = async (
  phone: string
): Promise<User> => {
  const existing = await pool.query<{ id: number; phone: string }>(
    `SELECT id, phone FROM users WHERE phone = $1 LIMIT 1`,
    [phone]
  );

  const row = existing.rows[0];
  if (row) {
    const push = await pool.query<{ push_token: string }>(
      `
      SELECT push_token
      FROM push_tokens
      WHERE user_id = $1
      ORDER BY updated_at DESC
      LIMIT 1
      `,
      [row.id]
    );
    return {
      id: row.id,
      phone: row.phone,
      pushToken: push.rows[0]?.push_token ?? null,
    };
  }

  const inserted = await pool.query<{ id: number; phone: string }>(
    `INSERT INTO users (phone) VALUES ($1) RETURNING id, phone`,
    [phone]
  );
  const created = inserted.rows[0];
  if (!created) {
    throw new Error("Failed to create user by phone");
  }
  return {
    id: created.id,
    phone: created.phone,
    pushToken: null,
  };
};

export const db = pool;
