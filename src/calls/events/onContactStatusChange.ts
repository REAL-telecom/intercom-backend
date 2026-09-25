import { FastifyInstance } from "fastify";
import { dialPendingContacts } from "../dial";
import { removeEndpointIfNoContacts } from "../endpoints";
import { readAppearedContactAor, readRemovedContactAor } from "../parsers";

import type { AriEvent } from "../../types";

export const onContactStatusChange = async (event: AriEvent, app: FastifyInstance) => {
  const appearedEndpointId = readAppearedContactAor(event);
  if (appearedEndpointId) {
    try {
      await dialPendingContacts(appearedEndpointId, "event", app);
    } catch (error) {
      app.log.warn({ err: error, endpointId: appearedEndpointId }, "ContactStatusChange: failed to originate");
    }
    return;
  }
  const removedEndpointId = readRemovedContactAor(event);
  if (removedEndpointId) {
    try {
      await removeEndpointIfNoContacts(removedEndpointId, app);
    } catch (error) {
      app.log.warn({ err: error, endpointId: removedEndpointId }, "ContactStatusChange: failed to remove endpoint");
    }
  }
  return;
};
