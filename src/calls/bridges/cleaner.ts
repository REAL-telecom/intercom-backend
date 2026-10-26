import { FastifyInstance } from "fastify";
import { AriRequestError, deleteBridge, listBridges } from "#ari";
import { listCalls } from "#store/redis";

/**
 * cleanupStaleBridges — удаляет мост, на который не ссылается ни одна запись звонка.
 * Пока запись звонка содержит id моста, мост не снимается.
 * Снимается и пустой мост, и мост, в котором ещё есть каналы.
 *
 * @param app приложение
 */
export async function cleanupStaleBridges(app: FastifyInstance): Promise<void> {
  try {
    const bridges = await listBridges();
    const calls = await listCalls();
    const liveBridgeIds = new Set<string>();
    for (const call of calls) {
      if (call.bridgeId) {
        liveBridgeIds.add(call.bridgeId);
      }
    }
    for (const bridge of bridges) {
      if (liveBridgeIds.has(bridge.id)) {
        continue;
      }
      try {
        await deleteBridge(bridge.id);
        app.log.warn({ bridgeId: bridge.id }, "Cleanup: deleted orphan bridge");
      } catch (error) {
        if (error instanceof AriRequestError && error.status === 404) {
          app.log.debug({ err: error, bridgeId: bridge.id }, "Cleanup: orphan bridge already deleted");
          continue;
        }
        app.log.warn({ err: error, bridgeId: bridge.id }, "Cleanup: failed to delete orphan bridge");
      }
    }
  } catch (error) {
    app.log.warn({ err: error }, "Cleanup: failed to delete orphan bridges");
  }
}
