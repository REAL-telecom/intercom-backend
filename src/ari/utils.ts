import { env } from "../config";

/**
 * Возвращает базовый URL ARI REST без учётных данных в URL.
 *
 * @returns базовый URL с хостом и портом из конфигурации
 */
export function getBaseUrl() {
  return `http://${env.ariHost}:${env.ariPort}/ari`;
}

/**
 * Возвращает URL ARI WebSocket для потока событий без учётных данных в URL.
 *
 * @returns URL сокета с именем приложения из конфигурации
 */
export function getWsUrl() {
  return `ws://${env.ariHost}:${env.ariPort}/ari/events?app=${env.ariAppName}`;
}

/**
 * Возвращает HTTP Basic Authorization заголовок для запросов ARI.
 *
 * @returns значение заголовка `Authorization` с учётными данными из конфигурации
 */
export function getAuthHeader() {
  const token = Buffer.from(`${env.ariUser}:${env.ariPassword}`).toString("base64");
  return `Basic ${token}`;
}
