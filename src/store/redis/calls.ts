/**
 * Глоссарий.
 *
 * Звонок — ключ `call:${callId}`.
 * Содержит запись звонка:
 *  - канал панели,
 *  - идентификатор учётки телефона,
 *  - мост,
 *  - адрес,
 *  - пользователя и квартиру,
 *  - идентификатор панели для замка одного входящего.
 * Пароль SIP в эту запись не пишется: он уходит в Asterisk при создании учётки телефона.
 * Остальные ключи звонка производны от этой записи.
 * Результат вызова (набора номера) — ключ `dial_status:${callId}`.
 * Имя взято у DIALSTATUS из Asterisk, но значения наши:
 *  - `accepted` — трубку взяли,
 *  - `rejected` — отклонили через `/calls/end`,
 *  - `canceled` — панель сбросила, пока звонило,
 *  - `timedOut` — никто не ответил за окно дозвона.
 * Отсутствие ключа означает, что дозвон продолжается.
 * Ячейка `endpoint:${pjsipId}` — запись в Redis.
 * Значение — идентификатор звонка и тип.
 * Тип `panel` — замок одного входящего с панели. Панель либо в звонке, либо нет. Ячейка стоит на время входящего, чтобы второй одновременный вызов с той же панели был отклонён.
 * Тип `phone` — сторож дворника для учётки телефона.
 * Канал дозвона — ключ `dialed_channels:${callId}`.
 * Содержит идентификаторы ARI-каналов, созданных для попыток дозвона на контакты учётки телефона.
 * Каналов может быть несколько, по одному на контакт.
 * Когда трубку взяли, один канал из набора становится каналом звонка, остальные гасятся и каналом звонка не становятся.
 * Контакт — ключ `dialed_contacts:${callId}`.
 * Содержит строки контактов PJSIP, на которые уже отправлена попытка дозвона.
 * Защищает от повторного дозвона на тот же контакт между проходами цикла.
 * Канал звонка — ключ `channel:${channelId}`.
 * Связывает ARI-канал со звонком для уборки по событию `StasisEnd`.
 * В записи идентификатор звонка. Пишется на каждый канал, который участвует в звонке: отдельно для канала панели, отдельно для канала-ноги дозвона.
 * Заявка на дозвон — ключ `originate:${pjsipId}`.
 * Мост и канал панели. Дозвон уходит, когда у учётки телефона появляется контакт.
 * Уборка моста — ключ `bridge_cleanup:${bridgeId}`.
 * Отметка, что мост уже взят в уборку. Повторный захват не проходит.
 * Пуш о конце звонка — ключ `call_over_push:${callId}:${reason}`.
 * Отметка, что пуш по этой причине уже отправляли.
 */

import { redisClient } from "./client";

/**
 * Call — представляет запись звонка.
 * В записи канал панели, учётка телефона, пользователь и квартира пишутся всегда.
 * Мост, адрес и панель могут отсутствовать.
 *
 * @property id — идентификатор звонка
 * @property channelId — канал панели
 * @property phoneId — идентификатор учётки телефона
 * @property userId — пользователь, которому звонят
 * @property apartment — квартира
 * @property bridgeId — идентификатор моста для уборки
 * @property address — адрес для показа
 * @property panelId — идентификатор объекта PJSIP панели для замка одного входящего
 */
export type Call = {
  id: string;
  channelId: string;
  phoneId: string;
  userId: number;
  apartment: string;
  bridgeId?: string;
  address?: string;
  panelId?: string;
};

// ─── Данные звонка ──────────────────────────────────────────────────

/**
 * setCall — сохраняет запись звонка с TTL.
 * Ключ берётся из идентификатора внутри записи.
 * Пароль SIP сюда не входит.
 *
 * @param payload запись звонка
 * @param ttlSec время жизни записи в секундах
 */
export async function setCall(payload: Call, ttlSec: number) {
  const key = `call:${payload.id}`;
  await redisClient.set(key, JSON.stringify(payload), "EX", ttlSec);
}

/**
 * getCall — возвращает запись звонка по идентификатору.
 *
 * @param callId идентификатор звонка
 * @returns запись звонка или `null`, если её нет или истёк срок
 */
export async function getCall(callId: string): Promise<Call | null> {
  const key = `call:${callId}`;
  const value = await redisClient.get(key);
  if (!value) {
    return null;
  }
  return JSON.parse(value) as Call;
}

/**
 * clearCall — стирает данные звонка целиком одним действием.
 * Удаляет разом ключи данных, результата вызова, контактов, каналов и ячейки учётки телефона.
 * Замок панели снимает `releaseEndpoint`.
 * Нельзя удалять только результат вызова: данные звонка закрывают ложный пропущенный вызов.
 *
 * @param callId идентификатор звонка
 * @param endpointId идентификатор учётки телефона, если уже известен. Иначе берётся из записи звонка
 */
export async function clearCall(callId: string, endpointId?: string): Promise<void> {
  const call = await getCall(callId);
  const dialChannelIds = await listDialedChannels(callId);
  const resolvedEndpointId = endpointId ?? call?.phoneId;
  const keys = [
    `call:${callId}`,
    `dial_status:${callId}`,
    `dialed_contacts:${callId}`,
    `dialed_channels:${callId}`,
  ];
  if (resolvedEndpointId) {
    keys.push(`endpoint:${resolvedEndpointId}`, `originate:${resolvedEndpointId}`);
  }
  if (call?.channelId) {
    keys.push(`channel:${call.channelId}`);
  }
  for (const channelId of dialChannelIds) {
    keys.push(`channel:${channelId}`);
  }
  const panelId = call?.panelId;
  if (panelId) {
    await releaseEndpoint(panelId, callId);
  }
  if (keys.length > 0) {
    await redisClient.del(...keys);
  }
}

// ─── Результат вызова ───────────────────────────────────────────────

/**
 * DialStatus — представляет результат вызова.
 * Отсутствие ключа означает, что дозвон продолжается.
 *
 * Значения:
 *  - `accepted` — принят на устройстве, разговор идёт
 *  - `rejected` — отклонён через `/calls/end`
 *  - `canceled` — панель сбросила трубку, пока звонок звонил
 *  - `timedOut` — никто не ответил за окно дозвона
 */
type DialStatus = "accepted" | "rejected" | "canceled" | "timedOut";

/**
 * setDialStatus — сохраняет результат вызова.
 * Вызывается только из победившей ветки, там, где результат вызова уже определён.
 * `NX` защищает от гонки, если два пути решат записать результат вызова одновременно.
 *
 * @param callId идентификатор звонка
 * @param status сохраняемый результат вызова
 * @param ttlSec время жизни записи в секундах
 * @returns истина, если результат записан сейчас, ложь, если он уже стоял
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
 * getDialStatus — возвращает сохранённый результат вызова.
 *
 * @param callId идентификатор звонка
 * @returns результат вызова или `null`, если он ещё не установлен
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
 * markBridgeForCleanup — помечает мост на уборку.
 * `NX` защищает от гонки: если несколько обработчиков одновременно решили убрать мост, право получит только первый.
 *
 * @param bridgeId идентификатор моста
 * @param ttlSec время жизни признака в секундах
 * @returns истина, если право получил этот вызов, ложь, если оно уже занято
 */
export async function markBridgeForCleanup(bridgeId: string, ttlSec: number): Promise<boolean> {
  const key = `bridge_cleanup:${bridgeId}`;
  const result = await redisClient.set(key, "1", "EX", ttlSec, "NX");
  return result === "OK";
}

// ─── Пуш о конце звонка ─────────────────────────────────────────────

/**
 * markCallOverPushSet — ставит отметку, что пуш о конце звонка по этой причине уже отправляли.
 * `NX` защищает от гонки: если два пути решат отправить пуш одной причины, право получит только первый.
 *
 * @param callId идентификатор звонка
 * @param reason причина завершения, например `timeout` или `caller_hung_up`
 * @param ttlSec время жизни отметки в секундах
 * @returns истина, если отметку поставил этот вызов, ложь, если она уже стоит
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
 * addDialedChannel — добавляет идентификатор созданного ARI-канала в набор каналов дозвона.
 * Каналы надо снять, когда звонок завершится.
 *
 * @param callId идентификатор звонка
 * @param channelId идентификатор ARI-канала
 * @param ttlSec время жизни набора в секундах
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
 * listDialedChannels — возвращает идентификаторы ARI-каналов, созданных по звонку.
 * Если каналов нет, список пустой.
 *
 * @param callId идентификатор звонка
 * @returns список идентификаторов каналов
 */
export async function listDialedChannels(callId: string): Promise<string[]> {
  const key = `dialed_channels:${callId}`;
  return redisClient.smembers(key);
}

// ─── Контакты ───────────────────────────────────────────────────────

/**
 * addDialedContact — отмечает контакт один раз: этот контакт уже дозванивали.
 * Защита от повторного дозвона на тот же контакт между проходами цикла.
 *
 * @param callId идентификатор звонка
 * @param contact строка контакта PJSIP
 * @param ttlSec время жизни признака в секундах
 * @returns истина, если признак поставил этот вызов, ложь, если он уже стоит
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
 * removeDialedContact — снимает признак «контакт уже дозванивали» после неудачной оригинации.
 * Следующий проход цикла сможет дозвониться на этот же контакт снова.
 *
 * @param callId идентификатор звонка
 * @param contact строка контакта PJSIP
 */
export async function removeDialedContact(callId: string, contact: string): Promise<void> {
  const key = `dialed_contacts:${callId}`;
  await redisClient.srem(key, contact);
}

// ─── Ячейки endpoint: и каналы ──────────────────────────────────────

/**
 * Endpoint — представляет ячейку `endpoint:`.
 * Это ссылка на звонок и кто держит ячейку: панель или телефон.
 *
 * @property callId — идентификатор звонка
 * @property type — `panel` или `phone`
 */
type Endpoint = {
  callId: string;
  type: "panel" | "phone";
};

/**
 * setEndpoint — сохраняет ячейку `endpoint:` с TTL.
 * При `nx` существующая ячейка не перезаписывается. Так ставится замок панели: второй вызов с тем же идентификатором ячейку не затирает.
 *
 * @param pjsipId идентификатор объекта PJSIP
 * @param payload ссылка на звонок и тип ячейки
 * @param ttlSec время жизни в секундах
 * @param nx не перезаписывать существующий ключ
 * @returns истина, если запись поставил этот вызов
 */
export async function setEndpoint(
  pjsipId: string,
  payload: Endpoint,
  ttlSec: number,
  nx = false
): Promise<boolean> {
  const key = `endpoint:${pjsipId}`;
  const stored = JSON.stringify(payload);
  const result = nx
    ? await redisClient.set(key, stored, "EX", ttlSec, "NX")
    : await redisClient.set(key, stored, "EX", ttlSec);
  return result === "OK";
}

/**
 * getEndpoint — возвращает ячейку `endpoint:`.
 *
 * @param pjsipId идентификатор объекта PJSIP
 * @returns запись или `null`, если её нет, истёк срок или форма записи не опознана
 */
export async function getEndpoint(pjsipId: string): Promise<Endpoint | null> {
  const key = `endpoint:${pjsipId}`;
  const value = await redisClient.get(key);
  if (!value) {
    return null;
  }
  const stored = JSON.parse(value) as Endpoint;
  if (stored.type !== "panel" && stored.type !== "phone") {
    return null;
  }
  if (typeof stored.callId !== "string" || stored.callId.length === 0) {
    return null;
  }
  return stored;
}

/**
 * releaseEndpoint — освобождает ячейку `endpoint:`, если её держит этот звонок.
 * Ячейка с другим звонком остаётся.
 *
 * @param pjsipId идентификатор объекта PJSIP
 * @param callId идентификатор звонка, который держит ячейку
 */
export async function releaseEndpoint(pjsipId: string, callId: string): Promise<void> {
  const endpoint = await getEndpoint(pjsipId);
  if (endpoint?.callId === callId) {
    await deleteEndpoint(pjsipId);
  }
}

/**
 * deleteEndpoint — удаляет ячейку `endpoint:` в Redis.
 * Строку PJSIP в Asterisk не трогает.
 *
 * @param pjsipId идентификатор объекта PJSIP
 */
async function deleteEndpoint(pjsipId: string): Promise<void> {
  const key = `endpoint:${pjsipId}`;
  await redisClient.del(key);
}

/**
 * Channel — представляет ячейку `channel:`.
 *
 * @property callId — идентификатор звонка
 */
type Channel = {
  callId: string;
};

/**
 * setChannel — сохраняет запись канала ARI с TTL.
 * В записи идентификатор звонка, чтобы убрать канал по событию `StasisEnd`.
 *
 * @param channelId идентификатор канала ARI
 * @param payload запись канала
 * @param ttlSec время жизни в секундах
 */
export async function setChannel(channelId: string, payload: Channel, ttlSec: number) {
  const key = `channel:${channelId}`;
  await redisClient.set(key, JSON.stringify(payload), "EX", ttlSec);
}

/**
 * getChannel — возвращает запись канала ARI.
 *
 * @param channelId идентификатор канала ARI
 * @returns запись канала или `null`, если её нет или истёк срок
 */
export async function getChannel(channelId: string): Promise<Channel | null> {
  const key = `channel:${channelId}`;
  const value = await redisClient.get(key);
  return value ? (JSON.parse(value) as Channel) : null;
}

// ─── Ожидание дозвона ───────────────────────────────────────────────

/**
 * Originate — представляет ячейку `originate:`.
 *
 * @property bridgeId — идентификатор моста
 * @property channelId — идентификатор канала панели
 */
type Originate = {
  bridgeId: string;
  channelId: string;
};

/**
 * setOriginate — сохраняет заявку на дозвон с TTL.
 * Дозвон уходит, когда у учётки телефона появляется контакт.
 *
 * @param endpointId идентификатор учётки телефона
 * @param payload заявка на дозвон
 * @param ttlSec время жизни заявки в секундах
 */
export async function setOriginate(
  endpointId: string,
  payload: Originate,
  ttlSec: number
) {
  const key = `originate:${endpointId}`;
  await redisClient.set(key, JSON.stringify(payload), "EX", ttlSec);
}

/**
 * getOriginate — возвращает заявку на дозвон.
 *
 * @param endpointId идентификатор учётки телефона
 * @returns заявка на дозвон или `null`, если записи нет или истёк срок
 */
export async function getOriginate(endpointId: string): Promise<Originate | null> {
  const key = `originate:${endpointId}`;
  const value = await redisClient.get(key);
  return value ? (JSON.parse(value) as Originate) : null;
}

/**
 * deleteOriginate — удаляет заявку на дозвон после её обработки.
 *
 * @param endpointId идентификатор учётки телефона
 */
export async function deleteOriginate(endpointId: string) {
  const key = `originate:${endpointId}`;
  await redisClient.del(key);
}
