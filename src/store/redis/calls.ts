import { redisClient } from "./client";

/**
 * Store call data by callId with TTL.
 * Single entity for identifying a call; payload includes channelId, endpointId, credentials, etc.
 */
export const setCallData = async (callId: string, payload: object, ttlSec: number) => {
  const key = `call:${callId}`;
  await redisClient.set(key, JSON.stringify(payload), "EX", ttlSec);
};

/**
 * Load call data by callId.
 * Returns null when call is missing or expired.
 */
export const getCallData = async <T>(callId: string) => {
  const key = `call:${callId}`;
  const value = await redisClient.get(key);
  return value ? (JSON.parse(value) as T) : null;
};

/** Terminal call outcome. Absence of call_outcome:{callId} means the call is still ringing. */
export type CallOutcome = "accepted" | "rejected" | "timeout" | "canceled";

/**
 * Atomically claim the call outcome (SET NX). Returns true only for the first caller.
 * Set to 'accepted' when answered, 'rejected' on /calls/end (user decline), 'canceled' when the caller hangs up while ringing, 'timeout' when we hang up by timeout.
 */
export const claimCallOutcome = async (
  callId: string,
  outcome: CallOutcome,
  ttlSec: number
): Promise<boolean> => {
  const key = `call_outcome:${callId}`;
  const result = await redisClient.set(key, outcome, "EX", ttlSec, "NX");
  return result === "OK";
};

/**
 * Load claimed call outcome by callId.
 * Returns null when the call is still ringing (no outcome key).
 */
export const getCallOutcome = async (callId: string): Promise<CallOutcome | null> => {
  const key = `call_outcome:${callId}`;
  const value = await redisClient.get(key);
  if (value === "accepted" || value === "rejected" || value === "timeout" || value === "canceled") {
    return value;
  }
  return null;
};

/**
 * Add ARI id of an originated PJSIP leg to the set with TTL.
 * Key is originate_channels (plural) so it does not collide with the string key originate_channel.
 */
export const addOriginateChannelId = async (
  callId: string,
  channelId: string,
  ttlSec: number
): Promise<void> => {
  const key = `originate_channels:${callId}`;
  await redisClient.multi().sadd(key, channelId).expire(key, ttlSec).exec();
};

/**
 * Load ARI ids of all originated PJSIP legs, if any.
 */
export const getOriginateChannelIds = async (callId: string): Promise<string[]> => {
  const key = `originate_channels:${callId}`;
  return redisClient.smembers(key);
};

/**
 * Atomically claim that this contact has not been dialed yet.
 * Prevents dialing the same contact twice on adjacent passes of the periodic task.
 */
export const claimContactForDial = async (
  callId: string,
  contact: string,
  ttlSec: number
): Promise<boolean> => {
  const key = `dialed_contacts:${callId}`;
  const replies = await redisClient.multi().sadd(key, contact).expire(key, ttlSec).exec();
  const saddReply = replies?.[0];
  if (!saddReply) {
    return false;
  }
  const saddResult = saddReply[1];
  return typeof saddResult === "number" && saddResult === 1;
};

/**
 * Remove a contact from the dialed set after a failed originate.
 * Allows the next pass to dial the contact again.
 */
export const releaseContactForDial = async (
  callId: string,
  contact: string
): Promise<void> => {
  const key = `dialed_contacts:${callId}`;
  await redisClient.srem(key, contact);
};

/**
 * Derive callId by temporary endpoint id (inc_<callId> or out_<callId>).
 */
export const getCallIdByEndpointId = (endpointId: string): string | null => {
  if (endpointId.startsWith("inc_") || endpointId.startsWith("out_")) {
    return endpointId.slice(4);
  }
  return null;
};

/**
 * Store temporary endpoint session mapping with TTL.
 */
export const setEndpointSession = async (
  endpointId: string,
  payload: object,
  ttlSec: number
) => {
  const key = `endpoint:${endpointId}`;
  await redisClient.set(key, JSON.stringify(payload), "EX", ttlSec);
};

/**
 * Load endpoint session mapping.
 */
export const getEndpointSession = async <T>(endpointId: string) => {
  const key = `endpoint:${endpointId}`;
  const value = await redisClient.get(key);
  return value ? (JSON.parse(value) as T) : null;
};

/**
 * Store per-channel session info (callId, endpointId, bridgeId, etc.).
 * Used for cleanup on StasisEnd.
 */
export const setChannelSession = async (
  channelId: string,
  payload: object,
  ttlSec: number
) => {
  const key = `channel:${channelId}`;
  await redisClient.set(key, JSON.stringify(payload), "EX", ttlSec);
};

/**
 * Load channel session info.
 */
export const getChannelSession = async <T>(channelId: string) => {
  const key = `channel:${channelId}`;
  const value = await redisClient.get(key);
  return value ? (JSON.parse(value) as T) : null;
};

/**
 * Store pending originate request for endpoint.
 * When endpoint becomes online, originate will be triggered.
 */
export const setPendingOriginate = async (
  endpointId: string,
  payload: { bridgeId: string; channelId: string },
  ttlSec: number
) => {
  const key = `originate:${endpointId}`;
  await redisClient.set(key, JSON.stringify(payload), "EX", ttlSec);
};

/**
 * Load pending originate request.
 */
export const getPendingOriginate = async <T>(endpointId: string) => {
  const key = `originate:${endpointId}`;
  const value = await redisClient.get(key);
  return value ? (JSON.parse(value) as T) : null;
};

/**
 * Remove pending originate after it's been processed.
 */
export const deletePendingOriginate = async (endpointId: string) => {
  const key = `originate:${endpointId}`;
  await redisClient.del(key);
};

/**
 * Active incoming call from a panel (domophone). Key: incoming_panel:{panelId} -> callId.
 * Sets only if key does not exist (atomic "claim"). Returns true if we claimed the panel, false if another call already has it.
 */
export const setActiveIncomingFromPanel = async (
  panelId: string,
  callId: string,
  ttlSec: number
): Promise<boolean> => {
  const key = `incoming_panel:${panelId}`;
  const result = await redisClient.set(key, callId, "EX", ttlSec, "NX");
  return result === "OK";
};

/**
 * Get active incoming callId for panel, if any.
 */
export const getActiveIncomingFromPanel = async (panelId: string): Promise<string | null> => {
  const key = `incoming_panel:${panelId}`;
  return redisClient.get(key);
};

/**
 * Clear active incoming lock for panel.
 */
export const clearActiveIncomingFromPanel = async (panelId: string) => {
  const key = `incoming_panel:${panelId}`;
  await redisClient.del(key);
};
