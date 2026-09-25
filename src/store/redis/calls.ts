/**
 * Глоссарий.
 *
 * Звонок — ключ call:${callId}.
 *   Содержит всю информацию о звонке:
 *     - канал панели,
 *     - временную учётку,
 *     - мост,
 *     - адрес,
 *     - пользователя,
 *     - учётные данные SIP-аккаунта.
 *   Остальные ключи звонка — производные от них.
 * Состояние вызова — ключ dial_status:${callId}.
 *   Тип назван по DIALSTATUS из Asterisk, но значения наши собственные:
 *     - accepted — трубку взяли,
 *     - rejected — отклонили через /calls/end,
 *     - canceled — панель сбросила, пока звонило,
 *     - timedOut — никто не ответил за окно дозвона.
 *   Отсутствие ключа означает, что дозвон продолжается.
 * Панель — ключ panel:${panelId}.
 *   Хвост ключа — panelId, значение — callId текущего входящего с этой панели.
 *   Панель либо в звонке, либо нет. Ставится на время входящего, чтобы
 *   второй одновременный вызов с той же панели был отклонён.
 * Канал дозвона — ключ dialed_channels:${callId}.
 *   Содержит идентификаторы ARI-каналов, созданных для попыток дозвона
 *   на контакты временной учётки. Каналов может быть несколько,
 *   по одному на контакт. Когда трубку взяли, один канал из набора
 *   становится каналом звонка, остальные гасятся и каналом звонка
 *   не становятся.
 * Контакт — ключ dialed_contacts:${callId}.
 *   Содержит строки контактов PJSIP, на которые уже отправлена попытка
 *   дозвона. Защищает от повторного дозвона на тот же контакт
 *   между проходами цикла.
 * Эндпоинт — ключ endpoint:${endpointId}.
 *   Сторож дворника: по нему дворник решает, что учётка ещё нужна.
 *   Без типа звонка.
 * Канал звонка — ключ channel:${channelId}.
 *   Связывает ARI-канал со звонком или с мостом для уборки
 *   по событию StasisEnd. Записывается на каждый канал, участвующий
 *   в звонке: отдельно для канала панели, отдельно для канала-ноги дозвона.
 */

import { redisClient } from "./client";

// ─── Данные звонка ──────────────────────────────────────────────────

/**
 * Возвращает идентификатор звонка.
 *
 * @param endpointId — id временной учётки, tmp_<callId>
 * @returns идентификатор звонка или null, если префикс не опознан
 */
export function getCallId(endpointId: string): string | null {
  if (endpointId.startsWith("tmp_")) {
    return endpointId.slice(4);
  }
  return null;
}

/**
 * Сохраняет данные звонка по идентификатору с TTL.
 *
 * Единая сущность для идентификации звонка: канал панели, временная учётка,
 * учётные данные SIP-аккаунта, мост, адрес, пользователь.
 *
 * @param callId — идентификатор звонка
 * @param payload — произвольный набор полей состояния звонка
 * @param ttlSec — время жизни записи в секундах
 */
export async function setCall(callId: string, payload: object, ttlSec: number) {
  const key = `call:${callId}`;
  await redisClient.set(key, JSON.stringify(payload), "EX", ttlSec);
}

/**
 * Возвращает данные звонка по идентификатору.
 *
 * @param callId — идентификатор звонка
 * @returns данные звонка или null, если записи нет или истёк срок
 */
export async function getCall<T>(callId: string) {
  const key = `call:${callId}`;
  const value = await redisClient.get(key);
  return value ? (JSON.parse(value) as T) : null;
}

/**
 * Стирает данные звонка целиком одним действием.
 *
 * Удаляет все ключи звонка разом: данные, состояние вызова, контакты,
 * каналы, записи endpoint и канала, панель звонка.
 * Нельзя удалять только состояние — данные звонка закрывают
 * ложный пропущенный вызов.
 *
 * @param callId — идентификатор звонка
 * @param endpointId — временная учётка, если уже известна (иначе берётся из данных)
 */
export async function clearCall(callId: string, endpointId?: string): Promise<void> {
  const callData = await getCall<{
    channelId?: string;
    domophoneEndpointId?: string;
    endpointId?: string;
  }>(callId);
  const dialChannelIds = await listDialedChannels(callId);
  const resolvedEndpointId = endpointId ?? callData?.endpointId;
  const keys = [
    `call:${callId}`,
    `dial_status:${callId}`,
    `dialed_contacts:${callId}`,
    `dialed_channels:${callId}`,
  ];
  if (resolvedEndpointId) {
    keys.push(`endpoint:${resolvedEndpointId}`, `originate:${resolvedEndpointId}`);
  }
  if (callData?.channelId) {
    keys.push(`channel:${callData.channelId}`);
  }
  for (const channelId of dialChannelIds) {
    keys.push(`channel:${channelId}`);
  }
  const panelId = callData?.domophoneEndpointId;
  if (panelId) {
    const activeCallId = await getPanel(panelId);
    if (activeCallId === callId) {
      keys.push(`panel:${panelId}`);
    }
  }
  if (keys.length > 0) {
    await redisClient.del(...keys);
  }
}

// ─── Состояние вызова ───────────────────────────────────────────────

/**
 * Состояние вызова.
 *
 * Значения:
 *   accepted — принят на устройстве, разговор идёт
 *   rejected — отклонён через /calls/end
 *   canceled — панель сбросила трубку, пока звонок звонил
 *   timedOut — никто не ответил за окно дозвона
 *
 * Отсутствие ключа означает, что дозвон продолжается.
 */
export type DialStatus = "accepted" | "rejected" | "canceled" | "timedOut";

/**
 * Сохраняет состояние вызова.
 * Вызывается только из победившей ветки — того места, где состояние уже
 * определено. NX внутри защищает от гонки, если два пути решат одновременно.
 *
 * @param callId — идентификатор звонка
 * @param status — устанавливаемое состояние
 * @param ttlSec — время жизни записи в секундах
 * @returns true, если состояние установлено этим вызовом, false — если уже было
 */
export async function setDialStatus(
  callId: string,
  status: DialStatus,
  ttlSec: number
): Promise<boolean> {
  const key = `dial_status:${callId}`;
  const result = await redisClient.set(key, status, "EX", ttlSec, "NX");
  return result === "OK";
}

/**
 * Возвращает сохранённое состояние вызова.
 *
 * @param callId — идентификатор звонка
 * @returns состояние вызова или null, если состояние ещё не установлено
 */
export async function getDialStatus(callId: string): Promise<DialStatus | null> {
  const key = `dial_status:${callId}`;
  const value = await redisClient.get(key);
  if (value === "accepted" || value === "rejected" || value === "timedOut" || value === "canceled") {
    return value;
  }
  return null;
}

// ─── Уборка моста ───────────────────────────────────────────────────

/**
 * Помечает мост на уборку. NX защищает от гонки: если несколько
 * обработчиков одновременно решили убрать мост, право получит только первый.
 *
 * @param bridgeId — идентификатор моста
 * @param ttlSec — время жизни признака в секундах
 * @returns true, если право получил этот вызов, false — если уже занято
 */
export async function markBridgeForCleanup(bridgeId: string, ttlSec: number): Promise<boolean> {
  const key = `bridge_cleanup:${bridgeId}`;
  const result = await redisClient.set(key, "1", "EX", ttlSec, "NX");
  return result === "OK";
}

// ─── Пуш о конце звонка ─────────────────────────────────────────────

/**
 * Ставит отметку: пуш о конце звонка по этой причине уже слали.
 * NX защищает от гонки: если два пути решат отправить пуш одной причины,
 * право получит только первый.
 *
 * @param callId — идентификатор звонка
 * @param reason — причина завершения (timeout, caller_hung_up и т.п.)
 * @param ttlSec — время жизни отметки в секундах
 * @returns true, если отметку поставил этот вызов, false — если уже стоит
 */
export async function markCallOverPushSet(
  callId: string,
  reason: string,
  ttlSec: number
): Promise<boolean> {
  const key = `call_over_push:${callId}:${reason}`;
  const result = await redisClient.set(key, "1", "EX", ttlSec, "NX");
  return result === "OK";
}

// ─── Каналы ─────────────────────────────────────────────────────────

/**
 * Добавляет идентификатор созданного ARI-канала в набор каналов.
 * Каналы надо снять, когда звонок завершится.
 *
 * @param callId — идентификатор звонка
 * @param channelId — идентификатор ARI-канала
 * @param ttlSec — время жизни набора в секундах
 */
export async function addDialedChannel(
  callId: string,
  channelId: string,
  ttlSec: number
): Promise<void> {
  const key = `dialed_channels:${callId}`;
  await redisClient.multi().sadd(key, channelId).expire(key, ttlSec).exec();
}

/**
 * Возвращает все идентификаторы ARI-каналов, созданных по звонку.
 * Пустой массив — если каналов нет.
 *
 * @param callId — идентификатор звонка
 * @returns список идентификаторов созданных каналов
 */
export async function listDialedChannels(callId: string): Promise<string[]> {
  const key = `dialed_channels:${callId}`;
  return redisClient.smembers(key);
}

// ─── Контакты ───────────────────────────────────────────────────────

/**
 * Отмечает контакт один раз: ставит признак «этот контакт уже дозванивали».
 * Защита от повторного дозвона на тот же контакт между проходами цикла.
 *
 * @param callId — идентификатор звонка
 * @param contact — строка контакта PJSIP
 * @param ttlSec — время жизни признака в секундах
 * @returns true, если признак поставил этот вызов, false — если уже стоит
 */
export async function addDialedContact(
  callId: string,
  contact: string,
  ttlSec: number
): Promise<boolean> {
  const key = `dialed_contacts:${callId}`;
  const replies = await redisClient.multi().sadd(key, contact).expire(key, ttlSec).exec();
  const saddReply = replies?.[0];
  if (!saddReply) {
    return false;
  }
  const saddResult = saddReply[1];
  return typeof saddResult === "number" && saddResult === 1;
}

/**
 * Снимает признак «контакт уже дозванивали» после неудачной оригинации.
 * Следующий проход цикла сможет дозвониться на этот же контакт снова.
 *
 * @param callId — идентификатор звонка
 * @param contact — строка контакта PJSIP
 */
export async function removeDialedContact(callId: string, contact: string): Promise<void> {
  const key = `dialed_contacts:${callId}`;
  await redisClient.srem(key, contact);
}

// ─── Записи endpoint и канала ───────────────────────────────────────

/**
 * Сохраняет запись временной учётки с TTL.
 * Используется дворником, чтобы понять, жива ли учётка.
 *
 * @param endpointId — id временной учётки
 * @param payload — данные временной учётки
 * @param ttlSec — время жизни в секундах
 */
export async function setEndpoint(endpointId: string, payload: object, ttlSec: number) {
  const key = `endpoint:${endpointId}`;
  await redisClient.set(key, JSON.stringify(payload), "EX", ttlSec);
}

/**
 * Возвращает запись временной учётки.
 *
 * @param endpointId — id временной учётки
 * @returns данные временной учётки или null, если записи нет или истёк срок
 */
export async function getEndpoint<T>(endpointId: string) {
  const key = `endpoint:${endpointId}`;
  const value = await redisClient.get(key);
  return value ? (JSON.parse(value) as T) : null;
}

/**
 * Сохраняет запись канала ARI с TTL.
 * Хранит callId или bridgeId для уборки по событию StasisEnd.
 *
 * @param channelId — идентификатор канала ARI
 * @param payload — данные канала
 * @param ttlSec — время жизни в секундах
 */
export async function setChannel(channelId: string, payload: object, ttlSec: number) {
  const key = `channel:${channelId}`;
  await redisClient.set(key, JSON.stringify(payload), "EX", ttlSec);
}

/**
 * Возвращает запись канала ARI.
 *
 * @param channelId — идентификатор канала ARI
 * @returns данные канала или null, если записи нет или истёк срок
 */
export async function getChannel<T>(channelId: string) {
  const key = `channel:${channelId}`;
  const value = await redisClient.get(key);
  return value ? (JSON.parse(value) as T) : null;
}

// ─── Ожидание дозвона ───────────────────────────────────────────────

/**
 * Сохраняет заявку на дозвон с TTL.
 * Дозвон уходит, когда у временной учётки появляется контакт.
 *
 * @param endpointId — id временной учётки
 * @param payload — мост и канал панели для дозвона
 * @param ttlSec — время жизни заявки в секундах
 */
export async function setOriginate(
  endpointId: string,
  payload: { bridgeId: string; channelId: string },
  ttlSec: number
) {
  const key = `originate:${endpointId}`;
  await redisClient.set(key, JSON.stringify(payload), "EX", ttlSec);
}

/**
 * Возвращает заявку на дозвон.
 *
 * @param endpointId — id временной учётки
 * @returns данные заявки или null, если записи нет или истёк срок
 */
export async function getOriginate<T>(endpointId: string) {
  const key = `originate:${endpointId}`;
  const value = await redisClient.get(key);
  return value ? (JSON.parse(value) as T) : null;
}

/**
 * Удаляет заявку на дозвон после её обработки.
 *
 * @param endpointId — id временной учётки
 */
export async function deleteOriginate(endpointId: string) {
  const key = `originate:${endpointId}`;
  await redisClient.del(key);
}

// ─── Панель ───────────────────────────────────────────────────────

/**
 * Закрепляет панель за звонком. NX защищает от гонки, если с той же панели
 * одновременно пришёл второй вызов.
 * Ключ: panel:${panelId} → callId.
 *
 * @param panelId — идентификатор панели
 * @param callId — идентификатор звонка
 * @param ttlSec — время жизни записи в секундах
 * @returns true, если панель закрепил этот вызов, false — если с панели уже идёт другой звонок
 */
export async function setPanel(
  panelId: string,
  callId: string,
  ttlSec: number
): Promise<boolean> {
  const key = `panel:${panelId}`;
  const result = await redisClient.set(key, callId, "EX", ttlSec, "NX");
  return result === "OK";
}

/**
 * Возвращает идентификатор звонка, за которым закреплена панель.
 *
 * @param panelId — идентификатор панели
 * @returns идентификатор звонка или null, если панель свободна
 */
export async function getPanel(panelId: string): Promise<string | null> {
  const key = `panel:${panelId}`;
  return redisClient.get(key);
}

/**
 * Освобождает панель после конца звонка.
 *
 * @param panelId — идентификатор панели
 */
export async function deletePanel(panelId: string) {
  const key = `panel:${panelId}`;
  await redisClient.del(key);
}
