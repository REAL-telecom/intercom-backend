/**
 * Глоссарий.
 *
 * Мост — объект ARI `bridge`. Соединяет два и более канала.
 * Mixing-мост — мост типа `mixing`. Смешивает аудиопотоки всех участников.
 * Подходит и для обычного звонка «точка-точка», и для конференции.
 */

import { request } from "./request";

/**
 * Bridge — представляет ответ ARI на создание моста.
 *
 * @property id — идентификатор моста
 */
type Bridge = {
  id: string;
};

/**
 * createBridge — создаёт mixing-мост с видео.
 * Id задаёт вызывающий код.
 *
 * @param bridgeId идентификатор моста
 * @returns объект с идентификатором моста
 */
export async function createBridge(bridgeId: string) {
  const params = new URLSearchParams({ bridgeId });
  return request<Bridge>(`/bridges?${params.toString()}`, "POST", {
    type: "mixing",
    videoMode: "talker", // Включить видео в мосту
  });
}

/**
 * addChannelToBridge — добавляет канал в мост.
 *
 * @param bridgeId идентификатор моста
 * @param channelId идентификатор канала
 * @returns результат запроса
 */
export async function addChannelToBridge(bridgeId: string, channelId: string) {
  return request(`/bridges/${bridgeId}/addChannel`, "POST", {
    channel: channelId,
    role: "participant",
    absorbDTMF: false,
    mute: false,
  });
}

/**
 * getBridge — возвращает состояние моста.
 *
 * @param bridgeId идентификатор моста
 * @returns состояние моста
 */
export async function getBridge(bridgeId: string) {
  return request<{ id: string; channels: string[]; bridge_type: string; video_mode?: string }>(
    `/bridges/${bridgeId}`
  );
}

/**
 * listBridges — возвращает активные мосты.
 * Если ARI вернул не массив, результат пустой.
 *
 * @returns активные мосты
 */
export async function listBridges() {
  const bridges = await request<{ id: string; channels: string[]; creationtime: string }[]>("/bridges");
  return Array.isArray(bridges) ? bridges : [];
}

/**
 * deleteBridge — удаляет мост.
 *
 * @param bridgeId идентификатор моста
 * @returns результат запроса
 */
export async function deleteBridge(bridgeId: string) {
  return request(`/bridges/${bridgeId}`, "DELETE");
}
