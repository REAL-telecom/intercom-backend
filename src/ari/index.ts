/**
 * Глоссарий.
 *
 * ARI (Asterisk REST Interface) — это современный асинхронный интерфейс в системе Asterisk,
 *   который позволяет внешним приложениям программно управлять базовыми объектами телефонии:
 *   каналами (channel), мостами (bridge), конечными точками (endpoints), медиапотоками и записями.
 *   Он даёт разработчикам возможность создавать собственные коммуникационные приложения,
 *   выходя за рамки возможностей традиционного диалплана.
 */

export { AriTransportError } from "./request";
export { connectAriEvents } from "./websocket";
export {
  answerChannel,
  continueInDialplan,
  getChannel,
  getChannelVariable,
  hangupChannel,
  holdChannel,
  listChannels,
  originateCall,
  originateToDialplan,
} from "./channels";
export { addChannelToBridge, createBridge, deleteBridge, getBridge } from "./bridges";
export { createEndpoint, deleteEndpoint } from "./endpoints";
