/**
 * Глоссарий.
 *
 * ARI — асинхронный интерфейс Asterisk, Asterisk REST Interface.
 * Внешнее приложение через него управляет объектами телефонии: каналами, мостами, эндпоинтами, медиапотоками и записями.
 * Канал в ARI называется `channel`, мост — `bridge`, конечная точка — `endpoint`.
 * Через ARI приложение строит свой сценарий вызова и не ограничено обычным диалпланом.
 */

export { AriTransportError } from "./request";
export { websocket } from "./websocket";
export {
  createChannelInStasis,
  createChannelInDialplan,
  getChannel,
  listChannels,
  getChannelVariable,
  answerChannel,
  holdChannel,
  continueInDialplan,
  hangupChannel,
} from "./channels";
export { addChannelToBridge, createBridge, deleteBridge, getBridge } from "./bridges";
export { createEndpoint, deleteEndpoint } from "./endpoints";
