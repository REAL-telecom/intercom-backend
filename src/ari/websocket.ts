/**
 * Глоссарий.
 *
 * ARI (Asterisk REST Interface) — REST-интерфейс Asterisk: через него
 *   выполняются команды над каналами, мостами и эндпоинтами.
 * WebSocket-поток событий — канал, по которому Asterisk присылает события
 *   ARI: StasisStart, StasisEnd, ChannelDestroyed, ContactStatusChange
 *   и остальные. Подключается один раз, живёт весь процесс.
 * Backoff — рост задержки между попытками переподключения. Здесь
 *   экспоненциальный: каждая следующая пауза вдвое длиннее предыдущей.
 */

import WebSocket, { RawData } from "ws";

import { getAuthHeader, getWsUrl } from "./utils";

import type { FastifyBaseLogger } from "fastify";
import type { AriEvent, AriEventHandler } from "../types";

// Первая пауза между попытками переподключения, миллисекунды.
const ARI_RECONNECT_MIN_DELAY_MS = 1000;

// Предел паузы между попытками переподключения, миллисекунды.
const ARI_RECONNECT_MAX_DELAY_MS = 30_000;

// Предел показателя степени в backoff: дальше двойка не растёт, пауза упирается в верхний предел.
const ARI_RECONNECT_MAX_EXPONENT = 5;

/**
 * Подключает приложение к потоку событий ARI WebSocket.
 *
 * Переподключается при закрытии сокета с экспоненциальной задержкой до 30 секунд.
 * Счётчик попыток сбрасывается при успешном открытии.
 *
 * @param onEvent — обработчик события ARI, может вернуть Promise
 * @param logger — логгер Fastify
 * @returns открытый WebSocket при первом подключении. Сокеты, созданные
 *   при переподключении, наружу не возвращаются: connect вызывается
 *   из close повторно.
 */
export function websocket(onEvent: AriEventHandler, logger: FastifyBaseLogger) {
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
      let event: AriEvent;
      try {
        event = JSON.parse(data.toString()) as AriEvent;
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
