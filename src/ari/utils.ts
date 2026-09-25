import { env } from "../config";

/**
 * getBaseUrl — возвращает базовый URL REST ARI.
 * Учётные данные в URL не входят.
 *
 * @returns базовый URL
 */
export function getBaseUrl() {
  return `http://${env.ariHost}:${env.ariPort}/ari`;
}

/**
 * getWsUrl — возвращает URL потока событий ARI.
 * Учётные данные в URL не входят.
 *
 * @returns URL сокета
 */
export function getWsUrl() {
  return `ws://${env.ariHost}:${env.ariPort}/ari/events?app=${env.ariAppName}`;
}

/**
 * getAuthHeader — возвращает значение заголовка `Authorization` для запросов ARI.
 *
 * @returns значение заголовка
 */
export function getAuthHeader() {
  const token = Buffer.from(`${env.ariUser}:${env.ariPassword}`).toString("base64");
  return `Basic ${token}`;
}
