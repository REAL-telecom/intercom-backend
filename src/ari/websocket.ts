/**
 * Глоссарий.
 *
 * ARI — интерфейс Asterisk, через который выполняются команды над каналами, мостами и эндпоинтами.
 * Поток событий — соединение WebSocket, по которому Asterisk присылает события ARI, например `StasisStart`, `StasisEnd`, `ChannelDestroyed`, `ContactStatusChange` и остальные.
 * Соединение одно на процесс и живёт, пока живёт процесс.
 * Backoff — рост паузы между попытками переподключения.
 * Здесь рост экспоненциальный: каждая следующая пауза вдвое длиннее предыдущей, пока не упрётся в верхний предел.
 */

import WebSocket, { RawData } from "ws";

import { getAuthHeader, getWsUrl } from "./utils";

import type { FastifyBaseLogger } from "fastify";

/**
 * Event — представляет событие из потока ARI.
 *
 * @property type — имя события
 */
export type Event = {
  type: string;
  [key: string]: unknown;
};

/**
 * EventHandler — представляет обработчик события из потока ARI.
 */
export type EventHandler = (event: Event) => void | Promise<void>;

/**
 * ARI_RECONNECT_MIN_DELAY_MS — задаёт первую паузу между попытками переподключения.
 */
const ARI_RECONNECT_MIN_DELAY_MS = 1000;

/**
 * ARI_RECONNECT_MAX_DELAY_MS — задаёт предел паузы между попытками переподключения.
 */
const ARI_RECONNECT_MAX_DELAY_MS = 30_000;

/**
 * ARI_RECONNECT_MAX_EXPONENT — задаёт предел показателя степени при росте паузы.
 * Дальше пауза не растёт и упирается в `ARI_RECONNECT_MAX_DELAY_MS`.
 */
const ARI_RECONNECT_MAX_EXPONENT = 5;

/**
 * websocket — подключает приложение к потоку событий ARI.
 * При закрытии сокета подключается снова. Пауза растёт до `ARI_RECONNECT_MAX_DELAY_MS` и сбрасывается при успешном открытии.
 * Наружу возвращается только сокет первого подключения.
 *
 * Как работает:
 * 1. Открывает сокет и при успехе обнуляет счётчик попыток
 * 2. Разбирает входящее сообщение как JSON и передаёт его в `onEvent`
 * 3. Ошибку обработчика ловит отдельно, чтобы она не рвала сокет
 * 4. При ошибке сокета пишет в лог, новое подключение запускает закрытие
 * 5. При закрытии ждёт паузу и вызывает подключение снова
 *
 * @param onEvent обработчик события, может вернуть промис
 * @param logger логгер
 * @returns сокет первого подключения
 */
export function websocket(onEvent: EventHandler, logger: FastifyBaseLogger) {
  let attempts = 0;

  function connect() {
    const ws = new WebSocket(getWsUrl(), {
      headers: {
        Authorization: getAuthHeader(),
      },
    });

    // Открытие сокета: сброс счётчика попыток переподключения.
    ws.on("open", () => {
      attempts = 0;
      logger.info("ARI WebSocket connected successfully");
    });

    // Входящее сообщение: разбор JSON, вызов onEvent, перехват ошибок обработчика.
    ws.on("message", (data: RawData) => {
      let event: Event;
      try {
        event = JSON.parse(data.toString()) as Event;
      } catch {
        logger.warn("ARI message ignored, invalid payload");
        return;
      }
      // Обработчик может быть async: результат оборачиваем в промис, чтобы поймать отказ.
      Promise.resolve()
        .then(() => onEvent(event))
        .catch((error) => {
          logger.error({ err: error }, "ARI event handler failed");
        });
    });

    // Ошибка сокета: логируем, переподключение запустит close.
    ws.on("error", (error) => {
      logger.error({ err: error }, "ARI WebSocket error");
    });

    // Закрытие сокета: переподключение с экспоненциальным backoff.
    ws.on("close", (code, reason) => {
      const reasonText = reason ? reason.toString() : "";
      // Задержка переподключения: экспоненциальный backoff.
      // Показатель степени обрезается ARI_RECONNECT_MAX_EXPONENT, чтобы 2 ** attempts не рос дальше.
      // Верхний предел срезает результат.
      const delayMs = Math.min(
        ARI_RECONNECT_MAX_DELAY_MS,
        ARI_RECONNECT_MIN_DELAY_MS * 2 ** Math.min(attempts, ARI_RECONNECT_MAX_EXPONENT)
      );
      attempts += 1;
      logger.warn(
        { code, reason: reasonText, delayMs, attempt: attempts },
        "ARI WebSocket closed, retry scheduled"
      );
      setTimeout(connect, delayMs);
    });

    return ws;
  }

  return connect();
}
