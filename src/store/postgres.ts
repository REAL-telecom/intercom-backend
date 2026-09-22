/**
 * Глоссарий.
 *
 * PostgreSQL — база данных сервиса. Хранит постоянные объекты (адреса, панели,
 *   пользователи, push-токены) и realtime-таблицы Asterisk.
 * Realtime-таблицы — таблицы PJSIP, из которых Asterisk читает конфигурацию
 *   во время работы. Префикс ps_ в имени таблицы означает «PJSIP».
 * PJSIP-объект — три связанные записи Asterisk:
 *     - ps_aors — адрес записи: сколько контактов разрешено, срок жизни,
 *     - ps_auths — учётные данные SIP-аккаунта: логин и пароль,
 *     - ps_endpoints — сама оконечная точка: контекст, кодеки, медиа-настройки.
 * Pool — пул соединений с Postgres. Открывает сразу несколько соединений
 *   и раздаёт их запросам по мере надобности.
 * Шаблон эндпоинта — строка в ps_endpoints, от которой наследуются
 *   настоящие временные учётки. У нас два шаблона: tpl_domophone и tpl_client.
 */

import { Pool } from "pg";
import { env } from "../config";

import type { PushPlatform, PushTokenRecord } from "../types";

// Пул соединений с Postgres. Один на весь процесс: каждый запрос берёт
// свободное соединение из пула и возвращает обратно.
const pool = new Pool({
  host: env.postgres.host,
  port: env.postgres.port,
  database: env.postgres.db,
  user: env.postgres.user,
  password: env.postgres.password,
});

// ─── Схема базы ─────────────────────────────────────────────────────

/**
 * Создаёт схему базы, если таблиц ещё нет.
 *
 * Создаёт таблицы:
 *  - addresses, panels — адреса домов и привязка панелей к адресам,
 *  - users — жильцы: телефон, квартира, срок оплаты,
 *  - calls — журнал звонков, пока не читается,
 *  - ps_aors, ps_auths, ps_endpoints — realtime-таблицы PJSIP,
 *  - ps_registrations — исходящие регистрации Asterisk, например МультиФон,
 *  - push_tokens — FCM и APNs токены устройств пользователя.
 *
 * Вызывается один раз при старте, чтобы сервер поднимался на пустой базе.
 * Повторный запуск безопасен: все CREATE через IF NOT EXISTS.
 */
export async function createDatabaseSchema() {
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
      -- задел под платный журнал звонков: ссылка на превью записи
      preview_url TEXT,
      door_opened BOOLEAN DEFAULT FALSE
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ps_aors (
      id TEXT PRIMARY KEY,
      max_contacts INTEGER,
      contact TEXT,
      default_expiration INTEGER,
      maximum_expiration INTEGER
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
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (user_id, push_token)
    );
  `);
}

// ─── Адреса ─────────────────────────────────────────────────────────

/**
 * Адрес дома: улица, номер, необязательные части.
 * Привязан к панели и к пользователю. Квартира — отдельное поле пользователя,
 * не адреса.
 */
export type Address = {
  id: number;
  street: string;
  house: string;
  building: string | null;
  letter: string | null;
  structure: string | null;
};

/**
 * Создаёт запись адреса и возвращает её каноничные поля.
 * Опциональные части сохраняются как NULL, если не переданы.
 *
 * @param params.street — улица
 * @param params.house — номер дома
 * @param params.building — корпус, если есть
 * @param params.letter — литера, если есть
 * @param params.structure — строение, если есть
 * @returns сохранённая запись с присвоенным id
 */
export async function addAddress(params: {
  street: string;
  house: string;
  building?: string;
  letter?: string;
  structure?: string;
}): Promise<Address> {
  const { street, house, building, letter, structure } = params;
  const result = await pool.query<Address>(
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
}

/**
 * Возвращает адрес по идентификатору.
 *
 * @param addressId — идентификатор адреса
 * @returns адрес или null, если такого адреса нет
 */
export async function getAddress(addressId: number): Promise<Address | null> {
  const result = await pool.query<Address>(
    `
    SELECT id, street, house, building, letter, structure
    FROM addresses
    WHERE id = $1
    LIMIT 1
    `,
    [addressId]
  );
  return result.rows[0] ?? null;
}

/**
 * Собирает адрес в одну строку для пуша и отображения.
 * Квартира не входит: показывается отдельно, если нужна.
 *
 * @param record — запись адреса
 * @returns строка вида «ул. Ленина, д. 5, корп. 2, лит. А»
 */
export function formatAddress(record: Address): string {
  const parts = [`${record.street}, д. ${record.house}`];
  if (record.building) {
    parts.push(`корп. ${record.building}`);
  }
  if (record.letter) {
    parts.push(`лит. ${record.letter}`);
  }
  if (record.structure) {
    parts.push(`стр. ${record.structure}`);
  }
  return parts.join(", ");
}

// ─── Панели ─────────────────────────────────────────────────────────

/**
 * Панель домофона: IP-адрес и привязанный к ней адрес дома.
 */
export type Panel = {
  id: number;
  ip: string;
  address_id: number;
};

/**
 * Создаёт привязку панели к адресу.
 *
 * @param params.ip — IP-адрес панели; в базе хранится как inet
 * @param params.addressId — идентификатор адреса
 * @returns созданная запись с IP как строкой
 */
export async function addPanel(params: { ip: string; addressId: number }): Promise<Panel> {
  const { ip, addressId } = params;
  const result = await pool.query<Panel>(
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
}

/**
 * Возвращает панель по IP-адресу.
 *
 * @param ip — IP-адрес панели
 * @returns панель или null, если такой панели нет
 */
export async function getPanel(ip: string): Promise<Panel | null> {
  const result = await pool.query<Panel>(
    `
    SELECT id, ip::text AS ip, address_id
    FROM panels
    WHERE ip = $1::inet
    LIMIT 1
    `,
    [ip]
  );
  return result.rows[0] ?? null;
}

// ─── Пользователи ───────────────────────────────────────────────────

/**
 * Пользователь, найденный по адресу и квартире.
 * Отделён от User: содержит только то, что нужно для маршрутизации
 * входящего звонка — id и телефон. Push-токены у него не читаются,
 * они нужны только на этапе верификации телефона.
 */
export type ApartmentUser = {
  id: number;
  phone: string;
};

/**
 * Возвращает пользователя по адресу и квартире.
 *
 * @param addressId — идентификатор адреса
 * @param apartment — номер квартиры
 * @returns пользователь или null, если по этой паре никого нет
 */
export async function getUser(
  addressId: number,
  apartment: string
): Promise<ApartmentUser | null> {
  const result = await pool.query<ApartmentUser>(
    `
    SELECT id, phone
    FROM users
    WHERE address_id = $1 AND apartment = $2
    LIMIT 1
    `,
    [addressId, apartment]
  );
  return result.rows[0] ?? null;
}

/**
 * Пользователь после верификации телефона.
 * Отделён от ApartmentUser: к нему привязан последний push-токен,
 * нужный мобильному приложению для регистрации в FCM или APNs.
 */
export type User = {
  id: number;
  phone: string;
  pushToken: string | null;
};

/**
 * Возвращает пользователя по телефону или создаёт нового.
 * Если пользователь уже есть — возвращает его с последним push-токеном.
 *
 * @param phone — телефон в канонической форме 7XXXXXXXXXX
 * @returns пользователь с id, телефоном и последним push-токеном
 */
export async function getOrCreateUser(phone: string): Promise<User> {
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
}

// ─── Push-токены ────────────────────────────────────────────────────

/**
 * Сохраняет push-токен пользователя. Повторная запись того же токена
 * обновляет платформу и время.
 *
 * @param params.userId — идентификатор пользователя
 * @param params.pushToken — токен FCM или APNs
 * @param params.platform — платформа: android, ios_voip или ios_apns
 */
export async function savePushToken(params: {
  userId: number;
  pushToken: string;
  platform: PushPlatform;
}) {
  const { userId, pushToken, platform } = params;
  await pool.query(
    `
    INSERT INTO push_tokens (user_id, push_token, platform)
    VALUES ($1, $2, $3)
    ON CONFLICT (user_id, push_token)
    DO UPDATE SET platform = EXCLUDED.platform, updated_at = NOW();
    `,
    [userId, pushToken, platform]
  );
}

/**
 * Возвращает записи push-токенов пользователя: сам токен и платформу.
 *
 * @param userId — идентификатор пользователя
 * @returns список токенов; пустой массив, если токенов нет
 */
export async function listPushTokens(userId: number | string): Promise<PushTokenRecord[]> {
  const result = await pool.query<{ push_token: string; platform: PushPlatform }>(
    `SELECT push_token, platform FROM push_tokens WHERE user_id = $1`,
    [userId]
  );
  return result.rows.map((row) => ({
    pushToken: row.push_token,
    platform: row.platform,
  }));
}

/**
 * Убирает из набора токенов пользователя те, что FCM или APNs признали
 * недействительными: приложение удалено, токен просрочен.
 *
 * @param userId — идентификатор пользователя
 * @param tokens — список токенов для удаления; пустой список — выход без запроса
 */
export async function removePushTokens(userId: number | string, tokens: string[]) {
  if (tokens.length === 0) return;
  await pool.query(
    `DELETE FROM push_tokens WHERE user_id = $1 AND push_token = ANY($2::text[])`,
    [userId, tokens]
  );
}

// ─── Временные эндпоинты ────────────────────────────────────────────

/**
 * Возвращает идентификаторы временных SIP-endpoint: все inc_* и out_*.
 * Используется дворником, чтобы понять, какие учётки надо подобрать.
 * Постоянные эндпоинты — панель, МультиФон — в список не попадают.
 *
 * @returns список идентификаторов
 */
export async function listTempEndpoints(): Promise<string[]> {
  const result = await pool.query(
    `SELECT id FROM ps_endpoints WHERE id LIKE 'inc_%' OR id LIKE 'out_%'`
  );
  return result.rows.map((row: { id: string }) => row.id);
}

// ─── Шаблоны эндпоинтов ─────────────────────────────────────────────

/**
 * Заполняет таблицу ps_endpoints шаблонами по умолчанию: tpl_domophone
 * и tpl_client. Повторный вызов обновляет поле allow, остальные поля
 * не трогает.
 *
 * Шаблоны описывают кодеки, транспорт и медиа-настройки. Временные учётки
 * наследуются от них при создании.
 *
 * Вызывается один раз при старте после createDatabaseSchema.
 */
export async function seedEndpointTemplates() {
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
}
