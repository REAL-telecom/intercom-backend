/**
 * Глоссарий.
 *
 * PostgreSQL — база данных сервиса. Хранит постоянные объекты и realtime-таблицы Asterisk.
 * Постоянные объекты: адреса, панели, пользователи, push-токены.
 * Realtime-таблицы — таблицы PJSIP, из которых Asterisk читает конфигурацию во время работы. Префикс `ps_` в имени таблицы означает PJSIP.
 * PJSIP-объект — три связанные записи Asterisk:
 *  - `ps_aors` — адрес записи: сколько контактов разрешено и срок жизни
 *  - `ps_auths` — учётные данные SIP-аккаунта, логин и пароль
 *  - `ps_endpoints` — сама оконечная точка: контекст, кодеки, медиа-настройки
 * Pool — пул соединений с Postgres. Открывает сразу несколько соединений и раздаёт их запросам по мере надобности.
 * Шаблон эндпоинта — строка в `ps_endpoints`: `tpl_panel` и `tpl_client`.
 * Учётка телефона при создании поле `templates` не получает, поэтому от этих строк не наследуется.
 * `tpl_client` записывается при старте, других обращений к ней в коде нет.
 */

import { Pool } from "pg";
import { env } from "../config";

import type { PushPlatform, PushTokenRecord } from "../types";

/**
 * pool — представляет пул соединений с Postgres.
 * Один на весь процесс: каждый запрос берёт свободное соединение и возвращает его обратно.
 */
const pool = new Pool({
  host: env.postgres.host,
  port: env.postgres.port,
  database: env.postgres.db,
  user: env.postgres.user,
  password: env.postgres.password,
});

// ─── Схема базы ─────────────────────────────────────────────────────

/**
 * createDatabaseSchema — создаёт схему базы, если таблиц ещё нет.
 * Вызывается один раз при старте, чтобы сервер поднимался на пустой базе.
 * Повторный запуск безопасен: все таблицы создаются через `IF NOT EXISTS`.
 *
 * Таблицы:
 *  - `addresses` и `panels` — адреса домов и привязка панелей к адресам
 *  - `users` — жильцы: телефон, квартира, срок оплаты
 *  - `calls` — журнал звонков, пока не читается
 *  - `ps_aors`, `ps_auths`, `ps_endpoints` — realtime-таблицы PJSIP
 *  - `ps_registrations` — исходящие регистрации Asterisk, например МультиФон
 *  - `push_tokens` — токены FCM и APNs устройств пользователя
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
      -- задел под голосовую почту: имя ящика для индикатора сообщений на устройстве
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
      expiration INTEGER,
      fatal_retry_interval INTEGER,
      forbidden_retry_interval INTEGER,
      max_retries INTEGER,
      outbound_auth TEXT,
      retry_interval INTEGER,
      server_uri TEXT,
      transport TEXT
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
 * Address — представляет адрес дома.
 * Привязан к панели и к пользователю. Квартира сюда не входит: она лежит у пользователя.
 *
 * @property id — идентификатор адреса
 * @property street — улица
 * @property house — номер дома
 * @property building — корпус, если есть
 * @property letter — литера, если есть
 * @property structure — строение, если есть
 */
type Address = {
  id: number;
  street: string;
  house: string;
  building: string | null;
  letter: string | null;
  structure: string | null;
};

/**
 * addAddress — создаёт запись адреса.
 * Непереданная часть сохраняется как `NULL`.
 *
 * Поля `params`:
 *  - `street` — улица
 *  - `house` — номер дома
 *  - `building` — корпус, если есть
 *  - `letter` — литера, если есть
 *  - `structure` — строение, если есть
 *
 * @param params части адреса
 * @returns сохранённая запись с присвоенным идентификатором
 * @throws `Error`, если база не вернула строку
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
 * getAddress — возвращает адрес по идентификатору.
 *
 * @param addressId идентификатор адреса
 * @returns адрес или `null`, если такого адреса нет
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
 * formatAddress — возвращает адрес одной строкой для пуша и показа.
 * Квартира не входит: её показывают отдельно, если она нужна.
 * Например: «ул. Ленина, д. 5, корп. 2, лит. А, стр. 1».
 *
 * @param record запись адреса
 * @returns строка адреса
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
 * Panel — представляет панель домофона.
 *
 * @property id — идентификатор панели
 * @property ip — IP-адрес панели
 * @property address_id — идентификатор адреса дома
 */
type Panel = {
  id: number;
  ip: string;
  address_id: number;
};

/**
 * addPanel — создаёт привязку панели к адресу.
 * IP в базе хранится как `inet`, наружу возвращается строкой.
 *
 * @param params IP-адрес панели и идентификатор адреса
 * @returns созданная запись
 * @throws `Error`, если база не вернула строку
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
 * getPanel — возвращает панель по IP-адресу.
 *
 * @param ip IP-адрес панели
 * @returns панель или `null`, если такой панели нет
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
 * ApartmentUser — представляет пользователя, найденного по адресу и квартире.
 * Отделён от `User`: здесь только то, что нужно для маршрутизации входящего звонка, идентификатор и телефон.
 * Push-токены отсюда не читаются. Они нужны на этапе верификации телефона.
 *
 * @property id — идентификатор пользователя
 * @property phone — телефон
 */
type ApartmentUser = {
  id: number;
  phone: string;
};

/**
 * getUser — возвращает пользователя по адресу и квартире.
 *
 * @param addressId идентификатор адреса
 * @param apartment номер квартиры
 * @returns пользователь или `null`, если по этой паре никого нет
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
 * User — представляет пользователя после верификации телефона.
 * Отделён от `ApartmentUser`: здесь есть последний push-токен, он нужен приложению для регистрации в FCM или APNs.
 *
 * @property id — идентификатор пользователя
 * @property phone — телефон
 * @property pushToken — последний push-токен или пусто, если токена нет
 */
type User = {
  id: number;
  phone: string;
  pushToken: string | null;
};

/**
 * getOrCreateUser — возвращает пользователя по телефону или создаёт нового.
 * Если пользователь уже есть, к нему прикладывается последний push-токен.
 *
 * @param phone телефон в канонической форме `7XXXXXXXXXX`
 * @returns пользователь с идентификатором, телефоном и последним push-токеном
 * @throws `Error`, если пользователя не удалось создать
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
 * savePushToken — сохраняет push-токен пользователя.
 * Повторная запись того же токена обновляет платформу и время.
 *
 * @param params идентификатор пользователя, токен FCM или APNs и платформа
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
 * listPushTokens — возвращает push-токены пользователя: сам токен и платформу.
 *
 * @param userId идентификатор пользователя
 * @returns список токенов, пустой, если токенов нет
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
 * removePushTokens — убирает из набора пользователя токены, которые FCM или APNs признали недействительными.
 * Так бывает, когда приложение удалено или токен просрочен.
 * Пустой список завершает функцию без запроса в базу.
 *
 * @param userId идентификатор пользователя
 * @param tokens токены, которые нужно убрать
 */
export async function removePushTokens(userId: number | string, tokens: string[]) {
  if (tokens.length === 0) return;
  await pool.query(
    `DELETE FROM push_tokens WHERE user_id = $1 AND push_token = ANY($2::text[])`,
    [userId, tokens]
  );
}

// ─── Учётки телефона ────────────────────────────────────────────────

/**
 * listPhoneEndpoints — возвращает идентификаторы учёток телефона, у которых контекст `phone`.
 * Постоянные эндпоинты, панель и МультиФон, в список не попадают.
 * Используется дворником, чтобы понять, какие учётки телефона подобрать.
 *
 * @returns список идентификаторов
 */
export async function listPhoneEndpoints(): Promise<string[]> {
  const result = await pool.query(
    `SELECT id FROM ps_endpoints WHERE context = 'phone'`
  );
  return result.rows.map((row: { id: string }) => row.id);
}

// ─── Шаблоны эндпоинтов ─────────────────────────────────────────────

/**
 * seedEndpointTemplates — заполняет `ps_endpoints` строками `tpl_panel` и `tpl_client`.
 * Повторный вызов обновляет поле `allow`, остальные поля не трогает.
 * Строки описывают кодеки, транспорт и медиа-настройки.
 * `createEndpoint` поле `templates` не передаёт, поэтому учётка телефона от них не наследуется.
 * `tpl_client` записывается здесь и больше нигде не читается.
 * Вызывается один раз при старте после `createDatabaseSchema`.
 */
export async function seedEndpointTemplates() {
  await pool.query(
    `
    INSERT INTO ps_endpoints (
      id, transport, disallow, allow, direct_media, force_rport, rewrite_contact, rtp_symmetric
    ) VALUES (
      'tpl_panel', 'transport-udp', 'all', 'ulaw,alaw,h264', 'no', 'yes', 'yes', 'yes'
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
