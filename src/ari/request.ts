/**
 * Глоссарий.
 *
 * Идемпотентный запрос — запрос, повтор которого с теми же параметрами не меняет конечное состояние по сравнению с одним выполнением.
 * Повтор не создаёт объект второй раз и не дублирует данные.
 * Методы GET, PUT и DELETE идемпотентны. POST не идемпотентен.
 * Предикат — функция, которая возвращает булево значение.
 * Промис — результат асинхронной операции `Promise`. Состояния: `pending`, `fulfilled`, `rejected`.
 */

import { getAuthHeader, getBaseUrl } from "./utils";

/**
 * AriRequestError — представляет ошибку HTTP-ответа ARI.
 * Сервер вернул ответ с неуспешным статусом.
 *
 * @property body — тело ответа для диагностики
 * @property status — HTTP-статус ответа
 */
export class AriRequestError extends Error {
  readonly body: string;
  readonly status: number;

  constructor(status: number, body: string) {
    super(`ARI request failed: ${status} ${body}`);
    this.name = "AriRequestError";
    this.body = body;
    this.status = status;
  }
}

/**
 * AriTransportError — представляет транспортную ошибку запроса ARI.
 * HTTP-ответа нет: сеть, DNS или таймаут.
 *
 * @property cause — исходная ошибка
 * @property isTimeout — признак таймаута, а не прочего сетевого сбоя
 */
export class AriTransportError extends Error {
  readonly cause: unknown;
  readonly isTimeout: boolean;

  constructor(message: string, options: { cause: unknown; isTimeout: boolean }) {
    super(message);
    this.name = "AriTransportError";
    this.cause = options.cause;
    this.isTimeout = options.isTimeout;
  }
}

/**
 * REQUEST_TIMEOUT_MS — задаёт предел ожидания одного запроса ARI.
 */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * isTimeoutError — возвращает признак таймаута или прерывания.
 * Node fetch прячет `AbortError` внутрь `TypeError`, поэтому проверяется цепочка `cause`.
 *
 * @param error любая пойманная ошибка
 * @returns признак таймаута или прерывания
 */
function isTimeoutError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    if ("name" in current && (current.name === "TimeoutError" || current.name === "AbortError")) {
      return true;
    }
    if (!("cause" in current)) {
      break;
    }
    current = current.cause;
  }
  return false;
}

/**
 * toTransportError — преобразует ошибку запроса в `AriTransportError`.
 *
 * @param error исходная ошибка
 * @returns ошибка с сообщением и признаком таймаута
 */
function toTransportError(error: unknown): AriTransportError {
  const isTimeout = isTimeoutError(error);
  const detail = error instanceof Error ? error.message : "ARI request transport failed";
  return new AriTransportError(isTimeout ? `ARI request timed out: ${detail}` : `ARI request failed: ${detail}`, {
    cause: error,
    isTimeout,
  });
}

/**
 * formatRequestError — возвращает текст ошибки запроса в одном формате.
 *
 * @param error любая ошибка
 * @returns текст ошибки
 */
export function formatRequestError(error: unknown): string {
  return error instanceof AriRequestError
    ? `${error.status} ${error.body}`
    : error instanceof Error
      ? error.message
      : String(error);
}

/**
 * request — выполняет REST-запрос к ARI.
 *
 * Как работает:
 * 1. Отправляет запрос и ждёт не дольше `REQUEST_TIMEOUT_MS`
 * 2. При неуспешном статусе бросает `AriRequestError` со статусом и телом ответа
 * 3. При статусе `204` и при пустом теле возвращает `undefined`
 * 4. Разбирает тело как JSON, а если разбор не удался, возвращает текст
 * 5. Готовую `AriRequestError` пробрасывает дальше, прочую ошибку бросает как `AriTransportError`
 *
 * @param path путь относительно базового URL ARI, включая query-строку
 * @param method HTTP-метод
 * @param body тело запроса
 * @returns разобранное тело, текст при неудачном разборе или `undefined`
 * @throws `AriRequestError` при неуспешном HTTP-статусе
 * @throws `AriTransportError` при сбое до HTTP-ответа
 */
export async function request<T = unknown>(path: string, method = "GET", body?: unknown) {
  const init: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: getAuthHeader(),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  try {
    const res = await fetch(`${getBaseUrl()}${path}`, init);
    // Не-ok ответ: сохраняем status и тело для диагностики.
    if (!res.ok) {
      const text = await res.text();
      throw new AriRequestError(res.status, text);
    }

    // Многие эндпоинты ARI возвращают 204 No Content.
    if (res.status === 204) {
      return undefined as T;
    }

    // Часть успешных ответов ARI может иметь пустое тело.
    const text = await res.text();
    if (!text) {
      return undefined as T;
    }

    // Предпочитаем JSON-парсинг, но не считаем, что каждый ответ содержит JSON.
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  } catch (error) {
    // Ошибка нужного типа пробрасывается без изменений.
    if (error instanceof AriRequestError) {
      throw error;
    }
    throw toTransportError(error);
  }
}
