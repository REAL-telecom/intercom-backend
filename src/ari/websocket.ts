import WebSocket, { RawData } from "ws";

import { getAuthHeader, getWsUrl } from "./utils";

import type { FastifyBaseLogger } from "fastify";
import type { AriEvent, AriEventHandler } from "../types";

/**
 * Подключает приложение к потоку событий ARI WebSocket.
 *
 * Переподключается при закрытии сокета с экспоненциальной задержкой до 30 секунд.
 * Счётчик попыток сбрасывается при успешном открытии.
 *
 * @param onEvent — обработчик события ARI, может вернуть Promise
 * @param logger — логгер Fastify
 * @returns открытый WebSocket при первом подключении
 */
export function connectAriEvents(onEvent: AriEventHandler, logger: FastifyBaseLogger) {
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
      // Задержка переподключения: экспоненциальный backoff, максимум 30 секунд.
      const delayMs = Math.min(30000, 1000 * 2 ** Math.min(attempts, 5));
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
