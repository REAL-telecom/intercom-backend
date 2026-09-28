import { FastifyInstance } from "fastify";
import { dialPendingContacts } from "../dials";
import { removeEndpointIfNoContacts } from "../endpoints";
import { parseAppearedContactAor, parseRemovedContactAor } from "../parsers";
import { getEndpoint } from "#store/redis";

import type { Event } from "#ari";

async function isPhoneEndpoint(pjsipId: string): Promise<boolean> {
  const endpoint = await getEndpoint(pjsipId);
  return endpoint?.type === "phone";
}

export const onContactStatusChange = async (event: Event, app: FastifyInstance) => {
  const appearedEndpointId = parseAppearedContactAor(event);
  if (appearedEndpointId && (await isPhoneEndpoint(appearedEndpointId))) {
    try {
      await dialPendingContacts(appearedEndpointId, "event", app);
    } catch (error) {
      app.log.warn({ err: error, endpointId: appearedEndpointId }, "ContactStatusChange: failed to originate");
    }
    return;
  }
  const removedEndpointId = parseRemovedContactAor(event);
  if (removedEndpointId && (await isPhoneEndpoint(removedEndpointId))) {
    try {
      await removeEndpointIfNoContacts(removedEndpointId, app);
    } catch (error) {
      app.log.warn({ err: error, endpointId: removedEndpointId }, "ContactStatusChange: failed to remove endpoint");
    }
  }
  return;
};
