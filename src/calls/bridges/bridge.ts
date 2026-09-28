import { env } from "#config";
import { markBridgeForCleanup } from "#store/redis";
import { hangupChannel, deleteBridge, getBridge, AriRequestError } from "#ari";

import type { FastifyBaseLogger } from "fastify";

/**
 * Контекст вызова уборки моста.
 *
 * @property callId — идентификатор звонка
 * @property channelId — идентификатор канала, из-за которого запущена уборка
 * @property source — откуда пришла уборка
 */
export type CleanupBridgeContext = {
  callId?: string;
  channelId?: string;
  source: "channelLeftBridge" | "stasisEnd" | "timedOut" | "callsEnd" | "setupFailed";
};

/**
 * Убирает mixing-мост один раз: гасит оставшиеся каналы и удаляет мост.
 * Первый вызвавший побеждает через markBridgeForCleanup, остальные выходят сразу.
 *
 * @param bridgeId — идентификатор моста
 * @param skipChannelId — канал панели, который уже отправлен в диалплан
 *   (пути timeout и reject). Его не гасим
 * @param context — контекст вызова для лога
 * @param logger — логгер Fastify
 */
export async function cleanupBridge(
  bridgeId: string,
  skipChannelId: string | undefined,
  context: CleanupBridgeContext,
  logger: FastifyBaseLogger
): Promise<void> {
  if (!(await markBridgeForCleanup(bridgeId, env.callTokenTtlSec))) {
    return;
  }
  try {
    const bridgeInfo = await getBridge(bridgeId);
    let hangupFailed = false;
    if (bridgeInfo?.channels?.length) {
      for (const bridgeChannelId of bridgeInfo.channels) {
        if (bridgeChannelId === skipChannelId) continue;
        const hangupStatus = await hangupChannel(bridgeChannelId, logger);
        if (hangupStatus === "hungUp") {
          logger.info({ ...context, bridgeId, channelId: bridgeChannelId }, `${context.source}: hung up channel in bridge`);
        } else if (hangupStatus === "failed") {
          hangupFailed = true;
        }
      }
    }
    if (hangupFailed) {
      logger.warn({ bridgeId, ...context }, `${context.source}: skipping bridge delete, channel hangup failed`);
    } else {
      await deleteBridge(bridgeId);
      logger.info({ bridgeId, ...context }, `${context.source}: bridge deleted`);
    }
  } catch (error) {
    if (error instanceof AriRequestError && error.status === 404) {
      logger.debug({ err: error, bridgeId, ...context }, `${context.source}: bridge already deleted or cleanup failed`);
    } else {
      logger.warn({ err: error, bridgeId, ...context }, `${context.source}: bridge already deleted or cleanup failed`);
    }
  }
}
