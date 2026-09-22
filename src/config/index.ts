/**
 * Глоссарий.
 *
 * callToken — ключ исхода звонка в Redis. Живёт весь звонок плюс запас: если умрёт
 *   раньше звонка, сброс панели будет принят за отмену и на устройства уйдёт ложный
 *   пропущенный вызов.
 * AOR (Address of Record) — адрес записи PJSIP в Asterisk, к которому привязаны
 *   контакты устройства. Живёт столько же, сколько callToken: контакт и памятка
 *   звонка должны истекать вместе.
 * ringTimeout — окно дозвона панели: сколько гудит вызов, пока никто не взял трубку.
 *   На стенде 15 секунд для скорости прогонов, в продукте 30.
 */

import dotenv from "dotenv";

// Загружает переменные из .env в process.env. quiet: true — не выводит в консоль
// список подхваченных переменных.
dotenv.config({ quiet: true });

/**
 * Возвращает значение обязательной переменной окружения.
 *
 * @param key — имя переменной
 * @throws Error если переменная не задана или пуста
 */
const requireEnv = (key: string) => {
  const value = process.env[key];
  if (!value || value.length === 0) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
};

/**
 * Возвращает порт из строки или запасное значение, если строка не число.
 *
 * @param value — значение из переменной окружения
 * @param defaultPort — запасной порт, если значение не парсится
 */
const parsePort = (value: string, defaultPort: number) => {
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? defaultPort : n;
};

/**
 * Настройки сервиса, собранные из переменных окружения.
 * Обязательные переменные падают при старте, если не заданы.
 * Опциональные имеют запасное значение по умолчанию.
 */
export const env = {
  // Сервис.
  appPort: parsePort(process.env.SERVER_PORT ?? "3000", 3000),
  logLevel: process.env.LOG_LEVEL ?? "info",
  serverDomain: requireEnv("SERVER_DOMAIN"),
  serverIp: requireEnv("SERVER_IP"),

  // ARI: подключение к Asterisk REST Interface.
  ariHost: process.env.ARI_HOST ?? "127.0.0.1",
  ariPort: parsePort(process.env.ARI_PORT ?? "8088", 8088),
  ariUser: requireEnv("ARI_USER"),
  ariPassword: requireEnv("ARI_PASSWORD"),
  ariAppName: "intercom",

  // Исход звонка должен жить дольше самого звонка: если ключ истечёт первым,
  // сброс панели будет принят за отмену и на устройства уйдёт ложный пропущенный.
  // Просроченный сброс приходит на один проход дворника, поэтому запас
  // покрывает maxCallDurationSec плюс этот проход.
  callTokenTtlSec: 420,
  // Окно дозвона панели. На стенде 15 секунд ради скорости прогонов, в продукте 30.
  ringTimeoutSec: 15,
  maxCallDurationSec: 300,

  // Предел жизни контакта временной учётки, если каскадное удаление не сработало
  // (упал Asterisk или бэкенд посреди звонка). Равно callTokenTtlSec осознанно:
  // памятка звонка и контакт должны истекать вместе.
  tempAorExpirationSec: 420,

  // Redis: хранилище состояний звонков и лимитов.
  redisHost: process.env.REDIS_HOST ?? "127.0.0.1",
  redisPort: parsePort(process.env.REDIS_PORT ?? "6379", 6379),
  redisPassword: requireEnv("REDIS_PASSWORD"),

  // Postgres: постоянные данные и realtime-таблицы PJSIP.
  postgres: {
    host: process.env.POSTGRES_HOST ?? "127.0.0.1",
    port: parsePort(process.env.POSTGRES_PORT ?? "5432", 5432),
    db: requireEnv("POSTGRES_DB"),
    user: requireEnv("POSTGRES_USER"),
    password: requireEnv("POSTGRES_PASSWORD"),
  },

  // Пустая строка — FCM не настроен, push на Android молча пропускается.
  // Проверка конфигурации — в push/fcm.ts.
  firebaseServiceAccountPath: process.env.FIREBASE_SERVICE_ACCOUNT_PATH || "",

  // Пустые значения — APNs не настроен, push на iOS молча пропускается.
  // Проверка конфигурации — в push/apns.ts.
  apns: {
    keyPath: process.env.APNS_KEY_PATH ?? "",
    keyId: process.env.APNS_KEY_ID ?? "",
    teamId: process.env.APNS_TEAM_ID ?? "",
    bundleId: process.env.APNS_BUNDLE_ID ?? "",
    environment: process.env.APNS_ENVIRONMENT ?? "",
  },
};
