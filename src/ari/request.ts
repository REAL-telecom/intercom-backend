/**
 * Глоссарий.
 *
 * Идемпотентный запрос — запрос, многократное выполнение которого с теми же
 *   параметрами не меняет конечного состояния системы по сравнению
 *   с однократным выполнением. При повторе не возникает побочных эффектов:
 *   двойного создания, дублирования данных. HTTP-методы GET, PUT и DELETE
 *   идемпотентны. POST — нет.
 * Предикат — функция, возвращающая булево значение.
 * Промис (Promise) — результат асинхронной операции с состояниями
 *   pending / fulfilled / rejected.
 */

import { getAuthHeader, getBaseUrl } from "./utils";

/**
 * Ошибка HTTP-ответа ARI: сервер вернул res.ok === false.
 * Хранит status и body для диагностики. От транспортных ошибок (сеть, DNS,
 * таймаут) отличается наличием HTTP-статуса.
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
 * Транспортная ошибка ARI: сеть, DNS, таймаут fetch.
 * Флаг isTimeout отделяет таймаут (AbortSignal.timeout) от прочих сетевых
 * сбоев. Причина сохраняется в cause с учётом вложенных обёрток Node fetch.
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
 * Предельное время одного ARI-запроса в миллисекундах.
 */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Возвращает признак: где-то в цепочке error.cause сидит таймаут или AbortError.
 *
 * Нужен потому, что Node fetch заворачивает AbortSignal.timeout в TypeError,
 * и настоящая причина лежит на глубине до 5 уровней в .cause.
 *
 * @param error — любая ошибка, пойманная в запросе
 * @returns true, если причина по цепочке cause — таймаут или прерывание
 */
function hasTimeoutCause(error: unknown): boolean {
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
 * Приводит любую транспортную ошибку к типу AriTransportError.
 *
 * @param error — исходная ошибка любого типа
 * @returns AriTransportError с человекочитаемым сообщением и флагом isTimeout
 */
function toTransportError(error: unknown): AriTransportError {
  const isTimeout = hasTimeoutCause(error);
  const detail = error instanceof Error ? error.message : "ARI request transport failed";
  return new AriTransportError(isTimeout ? `ARI request timed out: ${detail}` : `ARI request failed: ${detail}`, {
    cause: error,
    isTimeout,
  });
}

/**
 * Возвращает текст ошибки запроса в одном формате.
 *
 * @param error — любая ошибка
 * @returns строка вида `status body` для AriRequestError, message для остальных,
 *   String(error) как запасной вариант
 */
export function formatRequestError(error: unknown): string {
  return error instanceof AriRequestError
    ? `${error.status} ${error.body}`
    : error instanceof Error
      ? error.message
      : String(error);
}

/**
 * Выполняет ARI REST-запрос.
 *
 * Возвращает ошибки, приведённые к типу:
 *   - AriRequestError со status и body при не-ok HTTP,
 *   - AriTransportError с флагом isTimeout при сетевых сбоях и таймауте fetch.
 *
 * 204 No Content и пустое тело успешного ответа дают undefined as T.
 *
 * @param path — путь относительно базового URL ARI, включая query-строку
 * @param method — HTTP-метод, по умолчанию GET
 * @param body — тело запроса, сериализуется в JSON, если передано
 * @returns распарсенный JSON, строку при неудачном парсинге или undefined
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
