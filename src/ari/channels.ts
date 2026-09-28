/**
 * Глоссарий.
 *
 * Канал — объект ARI `channel`. Соединение с одним endpoint, через которое идёт обмен медиа.
 * Диалплан — сценарий обработки вызова внутри Asterisk. В ARI называется `dialplan`.
 * Stasis — приложение ARI. Точка, в которой управление каналом переходит внешнему приложению.
 * Оригинация — операция ARI, при которой Asterisk сам создаёт исходящий канал на endpoint.
 * В документации ARI это `POST /channels`, «Create a new channel».
 * Ring — состояние канала: входящий звонок звонит, трубка ещё не взята.
 * Up — состояние канала: разговор идёт, участники соединены.
 */

import { env } from "#config";
import { AriRequestError, request } from "./request";

import type { FastifyBaseLogger } from "fastify";
import type { HangupReason } from "../types";

/**
 * HangupStatus — представляет статус попытки сбросить канал, который мог уже исчезнуть.
 *
 * Значения:
 *  - `hungUp` — канал существовал и сброшен
 *  - `alreadyGone` — канала уже нет
 *  - `failed` — сбросить не получилось по другой причине
 */
type HangupStatus = "hungUp" | "alreadyGone" | "failed";

/**
 * createChannelInStasis — создаёт канал в Stasis.
 * Asterisk сам звонит на endpoint, управление приходит в приложение.
 *
 * @param endpoint контакт PJSIP вида `PJSIP/<endpoint_id>`
 * @param appArgs аргументы, которые приложение получит в `StasisStart`
 * @returns идентификатор созданного канала
 * @throws `Error`, если ARI не вернул идентификатор канала
 */
export async function createChannelInStasis(endpoint: string, appArgs: string) {
  const channel = await request<{ id?: string }>("/channels", "POST", {
    endpoint,
    app: env.ariAppName,
    appArgs,
  });
  if (!channel?.id) {
    throw new Error("ARI originate returned no channel id");
  }
  return { id: channel.id };
}

/**
 * createChannelInDialplan — создаёт канал сразу в диалплане, минуя Stasis.
 * Переменные из `params.variables` доступны в диалплане.
 * Используется для рассылки OTP-кодов и обзвона.
 *
 * @param params контакт, контекст, экстеншен, приоритет и переменные канала
 * @returns ответ ARI на создание канала
 */
export async function createChannelInDialplan(params: {
  endpoint: string;
  context: string;
  extension: string;
  priority: number;
  variables: Record<string, string>;
}) {
  return request("/channels", "POST", {
    endpoint: params.endpoint,
    context: params.context,
    extension: params.extension,
    priority: params.priority,
    variables: params.variables,
  });
}

/**
 * getChannel — возвращает состояние канала.
 *
 * @param channelId идентификатор канала
 * @returns состояние канала
 */
export async function getChannel(channelId: string) {
  return request<{ id: string; state: string; name: string; caller: { number: string }; connected: { number: string } }>(
    `/channels/${channelId}`
  );
}

/**
 * listChannels — возвращает активные каналы.
 * Если ARI вернул не массив, результат пустой.
 *
 * @returns активные каналы
 */
export async function listChannels() {
  const channels = await request<{ id: string; name: string; creationtime: string }[]>("/channels");
  return Array.isArray(channels) ? channels : [];
}

/**
 * getChannelVariable — возвращает значение переменной канала.
 * Запрос вычисляет функции диалплана, в отличие от `GET /asterisk/variable`.
 * Отсутствующее значение приходит пустой строкой. Статус `404` обрабатывает вызывающий код.
 *
 * @param channelId идентификатор канала
 * @param variable имя переменной или функции диалплана
 * @returns значение переменной
 */
export async function getChannelVariable(channelId: string, variable: string): Promise<string> {
  const params = new URLSearchParams({ variable });
  const result = await request<{ value?: string }>(
    `/channels/${channelId}/variable?${params.toString()}`
  );
  return result?.value ?? "";
}

/**
 * answerChannel — отвечает на входящий канал.
 * Переводит канал из Ring в Up.
 *
 * @param channelId идентификатор канала
 * @returns результат запроса
 */
export async function answerChannel(channelId: string) {
  return request(`/channels/${channelId}/answer`, "POST");
}

/**
 * holdChannel — ставит входящий канал на удержание.
 *
 * @param channelId идентификатор канала
 * @returns результат запроса
 */
export async function holdChannel(channelId: string) {
  return request(`/channels/${channelId}/hold`, "POST");
}

/**
 * continueInDialplan — выводит канал из Stasis и продолжает его в диалплане.
 * Канал покидает мост сам. Так канал панели возвращается в диалплан и завершает вызов, например на ветке `noanswer`, `busy` или `invalid`.
 *
 * @param channelId идентификатор канала
 * @param context контекст диалплана
 * @param extension экстеншен
 * @param priority приоритет
 */
export async function continueInDialplan(
  channelId: string,
  context: string,
  extension: string,
  priority: number
): Promise<void> {
  const params = new URLSearchParams({
    context,
    extension,
    priority: String(priority),
  });
  await request(`/channels/${channelId}/continue?${params.toString()}`, "POST");
}

/**
 * hangupChannel — пытается сбросить канал, если он ещё существует.
 * Без идентификатора и при статусе `404` возвращает `alreadyGone`.
 * Прочую ошибку пишет в лог и возвращает `failed`.
 *
 * @param channelId идентификатор канала или пустое значение, если он неизвестен
 * @param logger логгер
 * @param reason причина сброса
 * @returns статус попытки
 */
export async function hangupChannel(
  channelId: string | null | undefined,
  logger: FastifyBaseLogger,
  reason?: HangupReason
): Promise<HangupStatus> {
  if (!channelId) {
    return "alreadyGone";
  }
  try {
    const params = reason ? `?${new URLSearchParams({ reason }).toString()}` : "";
    await request(`/channels/${channelId}${params}`, "DELETE");
    return "hungUp";
  } catch (error) {
    if (error instanceof AriRequestError && error.status === 404) {
      return "alreadyGone";
    }
    logger.warn({ err: error, channelId }, "ARI hangup failed");
    return "failed";
  }
}
