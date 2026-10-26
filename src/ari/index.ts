/**
 * Глоссарий.
 *
 * ARI — асинхронный интерфейс Asterisk, Asterisk REST Interface.
 * Внешнее приложение через него управляет объектами телефонии: каналами, мостами, эндпоинтами, медиапотоками и записями.
 * Канал в ARI называется `channel`, мост — `bridge`, эндпоинт — `endpoint`.
 * Через ARI приложение строит свой сценарий вызова и не ограничено обычным диалпланом.
 */

export { AriRequestError, AriTransportError } from "./request";
export { websocket, type Event } from "./websocket";
export {
  createChannelInStasis,
  createChannelInDialplan,
  getChannel,
  getChannelVariable,
  listChannels,
  answerChannel,
  holdChannel,
  continueInDialplan,
  hangupChannel,
} from "./channels";
export { addChannelToBridge, createBridge, deleteBridge, getBridge, listBridges } from "./bridges";
export { createEndpoint, deleteEndpoint } from "./endpoints";
