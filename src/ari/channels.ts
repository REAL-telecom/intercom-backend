/**
 * Глоссарий.
 *
 * channel (канал) — объект ARI: соединение с одним endpoint, через которое
 *   идёт обмен медиа.
 * dialplan (диалплан) — сценарий обработки вызова внутри Asterisk.
 * Stasis — приложение Asterisk ARI: точка передачи управления каналом
 *   внешнему приложению.
 * originate (оригинация) — операция ARI: Asterisk сам инициирует исходящий
 *   звонок на endpoint.
 *
 * Ring — состояние канала: входящий звонок звонит, трубка не взята.
 * Up — состояние канала: разговор идёт, участники соединены.
 */

import { env } from "../config";
import { AriRequestError, request } from "./request";

import type { FastifyBaseLogger } from "fastify";
import type { HangupReason } from "../types";

/**
 * Статус попытки повесить трубку каналу, который мог уже исчезнуть.
 *
 *   hungUp      — канал существовал и мы его сбросили
 *   alreadyGone — канала уже нет (404 или id не передан)
 *   failed      — сбросить не получилось по другой причине
 */
type HangupStatus = "hungUp" | "alreadyGone" | "failed";

/**
 * Возвращает информацию о канале, включая состояние.
 *
 * @param channelId — идентификатор канала ARI
 * @returns объект канала с полями `id`, `state`, `name`, `caller`, `connected`
 */
export async function getChannel(channelId: string) {
  return request<{ id: string; state: string; name: string; caller: { number: string }; connected: { number: string } }>(
    `/channels/${channelId}`
  );
}

/**
 * Возвращает список всех активных каналов.
 *
 * @returns список каналов с полями `id`, `name`, `creationtime`; пустой список,
 *   если ARI вернул не массив
 */
export async function listChannels() {
  const channels = await request<{ id: string; name: string; creationtime: string }[]>("/channels");
  return Array.isArray(channels) ? channels : [];
}

/**
 * Возвращает значение переменной или функции канала.
 *
 * В отличие от GET /asterisk/variable этот эндпоинт вычисляет функции диалплана.
 * 404 означает, что канал или переменная не найдены, вызывающий обязан это обработать.
 *
 * @param channelId — идентификатор канала ARI
 * @param variable — имя переменной или функции диалплана
 * @returns значение переменной или пустая строка, если поле `value` отсутствует
 */
export async function getChannelVariable(channelId: string, variable: string): Promise<string> {
  const params = new URLSearchParams({ variable });
  const result = await request<{ value?: string }>(
    `/channels/${channelId}/variable?${params.toString()}`
  );
  return result?.value ?? "";
}

/**
 * Отвечает на входящий канал: переводит из состояния Ring (звонит) в Up (разговор).
 *
 * @param channelId — идентификатор канала ARI
 */
export async function answerChannel(channelId: string) {
  return request(`/channels/${channelId}/answer`, "POST");
}

/**
 * Ставит входящий канал на удержание.
 *
 * @param channelId — идентификатор канала ARI
 */
export async function holdChannel(channelId: string) {
  return request(`/channels/${channelId}/hold`, "POST");
}

/**
 * Пытается повесить трубку каналу, если он ещё существует.
 *
 * Возвращает статус:
 *   hungUp      — канал сброшен
 *   alreadyGone — id не передан или ARI уже снёс канал (404)
 *   failed      — сбросить не получилось по другой причине
 *
 * @param channelId — id канала или null/undefined, если id неизвестен
 * @param logger — логгер Fastify
 * @param reason — необязательная причина, уходит query-параметром (answered_elsewhere и т.п.)
 * @returns статус попытки сброса
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

/**
 * Выводит канал из Stasis и продолжает его в диалплане.
 *
 * Канал покидает мост автоматически. Используется, чтобы вернуть канал панели
 * в диалплан: там он попадёт на нужную ветку (noanswer, busy, invalid) и корректно
 * завершит вызов.
 *
 * @param channelId — идентификатор канала ARI
 * @param context — контекст диалплана
 * @param extension — экстеншен (номер)
 * @param priority — приоритет
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
 * Оригинирует исходящий звонок на endpoint.
 *
 * @param endpoint — контакт PJSIP вида `PJSIP/<endpoint_id>`
 * @param appArgs — аргументы, которые приложение получит в StasisStart
 * @returns объект с идентификатором созданного канала
 * @throws Error, если ARI не вернул id канала
 */
export async function originateCall(endpoint: string, appArgs: string) {
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
 * Оригинирует в диалплан, минуя Stasis.
 *
 * Переменные канала доступны в диалплане как ${VAR}. Используется для сценариев,
 * где канал создаётся сразу в диалплане: рассылка OTP-кодов, обзвон.
 *
 * @param params.endpoint — контакт PJSIP вида `PJSIP/<endpoint_id>`
 * @param params.context — контекст диалплана
 * @param params.extension — экстеншен (номер)
 * @param params.priority — приоритет
 * @param params.variables — переменные канала, доступные в диалплане
 */
export async function originateToDialplan(params: {
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
