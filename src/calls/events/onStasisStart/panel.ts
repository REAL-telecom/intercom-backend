import { FastifyInstance } from "fastify";
import { continueInDialplan, hangupChannel } from "#ari";
import { parsePjsipId } from "../../parsers";
import {
  formatAddress,
  getAddress,
  getPanel as getPanelRecord,
  getUser,
} from "#store/postgres";

export type PanelCall = {
  panelId: string | null;
  userId: number;
  apartment: string;
  address: string;
};

/**
 * Читает панель и абонента из `StasisStart`.
 *
 * Нет абонента — канал уходит в invalid, запись звонка не создаётся.
 *
 * @param channel — канал панели из события
 * @param channelId — идентификатор канала ARI
 * @param eventArgs — аргументы стасиса: panel, IP, квартира
 * @param callId — идентификатор звонка, уже выбранный обработчиком
 * @param app — экземпляр Fastify
 * @returns данные панели или null, если звонок некому принять
 */
export async function readPanel(
  channel: { name?: string },
  channelId: string,
  eventArgs: unknown[],
  callId: string,
  app: FastifyInstance
): Promise<PanelCall | null> {
  const panelId = parsePjsipId(channel.name);
  const panelIpFromArgs = typeof eventArgs[1] === "string" ? eventArgs[1].trim() : "";
  const apartmentFromArgs = typeof eventArgs[2] === "string" ? eventArgs[2].trim() : "";
  const apartment = /^\d+$/.test(apartmentFromArgs) ? apartmentFromArgs : null;
  const panelIp = panelIpFromArgs || null;
  let address = "";
  let userId: number | null = null;
  if (!panelIp) {
    app.log.warn({ callId, channelId, args: eventArgs }, "Panel IP not found in Stasis args");
  } else if (!apartment) {
    app.log.warn({ callId, channelId, panelIp, args: eventArgs }, "Apartment not found in incoming call payload");
  } else {
    const panel = await getPanelRecord(panelIp);
    if (!panel) {
      app.log.warn({ callId, panelIp }, "Panel is not configured in DB");
    } else {
      const addressRecord = await getAddress(panel.address_id);
      if (addressRecord) {
        address = formatAddress(addressRecord);
      }
      const user = await getUser(panel.address_id, apartment);
      if (!user) {
        app.log.warn({ callId, panelIp, addressId: panel.address_id, apartment }, "User not found by address/apartment");
      } else {
        userId = user.id;
      }
    }
  }

  if (userId === null || apartment === null) {
    app.log.info({ callId, channelId, panelIp, apartment }, "No subscriber for incoming call, sending panel to invalid");
    try {
      await continueInDialplan(channelId, "panel", "invalid", 1);
      app.log.info({ channelId, callId }, "Panel channel sent to invalid");
    } catch (continueError) {
      app.log.warn(
        { err: continueError, channelId, callId },
        "Failed to continueInDialplan panel channel to invalid"
      );
      await hangupChannel(channelId, app.log);
    }
    return null;
  }

  return { panelId, userId, apartment, address };
}
