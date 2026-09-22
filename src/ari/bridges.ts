/**
 * Глоссарий.
 *
 * bridge (мост) — объект ARI: соединяет два и более канала.
 * mixing-мост — тип моста: смешивает аудиопотоки всех участников. 
 *   Подходит как и для обычного звонка «точка-точка», и для конференции.
 */

import { request } from "./request";

import type { AriBridge } from "../types";

/**
 * Создаёт mixing-мост с поддержкой видео.
 *
 * @returns объект с идентификатором созданного моста
 */
export async function createBridge() {
  return request<AriBridge>("/bridges", "POST", {
    type: "mixing",
    videoMode: "talker", // Включить видео в мосту
  });
}

/**
 * Добавляет канал в существующий мост.
 *
 * @param bridgeId — идентификатор моста
 * @param channelId — идентификатор канала ARI
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
 * Возвращает информацию о мосте, включая список каналов.
 *
 * @param bridgeId — идентификатор моста
 * @returns объект моста с полями `id`, `channels`, `bridge_type`, `video_mode`
 */
export async function getBridge(bridgeId: string) {
  return request<{ id: string; channels: string[]; bridge_type: string; video_mode?: string }>(
    `/bridges/${bridgeId}`
  );
}

/**
 * Удаляет мост.
 *
 * @param bridgeId — идентификатор моста
 */
export async function deleteBridge(bridgeId: string) {
  return request(`/bridges/${bridgeId}`, "DELETE");
}
