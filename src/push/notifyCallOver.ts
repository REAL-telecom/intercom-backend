import { env } from "../config";
import { acquireCallOverPush } from "../store/redis";
import { listPushTokens, removePushTokens } from "../store/postgres";
import { sendFcmCallEnded } from "./fcm";
import { sendApnsCallEndedPush } from "./apns";

import type { CallData, CallEndedReason } from "../types";
import type { FastifyBaseLogger } from "fastify";

const CALL_ENDED_PUSH_TITLE = "Пропущенный вызов";
const CALL_ENDED_PUSH_BODY_DEFAULT = "Звонок в домофон";

const MISSED_REASONS: ReadonlySet<CallEndedReason> = new Set([
  "timeout",
  "caller_hung_up",
]);

/**
 * Map Redis dial outcome to SIP_CALL_ENDED push reason.
 * Returns null when there is no outcome yet.
 */
export const callOutcomeToEndedReason = (
  outcome: "accepted" | "rejected" | "timedOut" | "canceled" | null
): CallEndedReason | null => {
  if (outcome === null) return null;
  if (outcome === "accepted") return "answered_elsewhere";
  if (outcome === "rejected") return "declined_elsewhere";
  if (outcome === "timedOut") return "timeout";
  return "caller_hung_up";
};

/**
 * Notify all user devices that the call is over (one push per callId+reason).
 * Missed reasons include title/body; others are silent. FCM and APNs run in parallel.
 */
export const notifyCallOver = async (
  callId: string,
  callData: CallData,
  reason: CallEndedReason,
  logger: FastifyBaseLogger
): Promise<void> => {
  try {
    const shouldNotify = await acquireCallOverPush(callId, reason, env.callTokenTtlSec);
    if (!shouldNotify) {
      logger.debug({ callId, reason }, "Call-over push already sent for this reason, skipping");
      return;
    }

    const userId = callData.userId ?? null;
    if (userId === null) {
      logger.warn(
        {
          callId,
          reason,
          domophoneEndpointId: callData.domophoneEndpointId,
          apartment: callData.apartment,
        },
        "No user mapping for call-ended push, skipping push"
      );
      return;
    }

    const records = await listPushTokens(userId);
    const androidTokens = records.filter((r) => r.platform === "android").map((r) => r.pushToken);
    const iosApnsTokens = records.filter((r) => r.platform === "ios_apns").map((r) => r.pushToken);
    if (androidTokens.length === 0 && iosApnsTokens.length === 0) {
      logger.warn(
        { callId, reason, userId },
        "No push tokens for call-ended push, skipping push"
      );
      return;
    }

    const isMissed = MISSED_REASONS.has(reason);
    const address = callData.address ?? "";
    const title = isMissed ? CALL_ENDED_PUSH_TITLE : undefined;
    const body = isMissed
      ? callData.address != null && callData.address !== ""
        ? callData.address
        : CALL_ENDED_PUSH_BODY_DEFAULT
      : undefined;

    const fcmPayload = {
      type: "SIP_CALL_ENDED" as const,
      callId,
      reason,
      ...(address !== "" ? { address } : {}),
      ...(title != null ? { title } : {}),
      ...(body != null ? { body } : {}),
    };
    const apnsPayload = {
      type: "SIP_CALL_ENDED" as const,
      callId,
      reason,
      ...(title != null ? { title } : {}),
      ...(body != null ? { body } : {}),
    };

    const invalidTokens: string[] = [];
    let fcmInvalidCount = 0;
    let apnsInvalidCount = 0;

    const tasks: Promise<void>[] = [];

    if (androidTokens.length > 0) {
      logger.info(
        { callId, reason, tokensCount: androidTokens.length, missed: isMissed },
        "Sending FCM call-ended push"
      );
      tasks.push(
        (async () => {
          try {
            const { invalidTokens: fcmInvalid } = await sendFcmCallEnded(
              androidTokens,
              fcmPayload
            );
            fcmInvalidCount = fcmInvalid.length;
            invalidTokens.push(...fcmInvalid);
            logger.info({ callId, reason }, "FCM call-ended push sent");
          } catch (error) {
            logger.warn({ err: error, callId, reason }, "Failed to send FCM call-ended push");
          }
        })()
      );
    }

    if (iosApnsTokens.length > 0) {
      logger.info(
        { callId, reason, tokensCount: iosApnsTokens.length, missed: isMissed },
        "Sending APNs call-ended push"
      );
      tasks.push(
        (async () => {
          try {
            const { invalidTokens: apnsInvalid } = await sendApnsCallEndedPush(
              iosApnsTokens,
              apnsPayload
            );
            apnsInvalidCount = apnsInvalid.length;
            invalidTokens.push(...apnsInvalid);
            logger.info({ callId, reason }, "APNs call-ended push sent");
          } catch (error) {
            logger.warn({ err: error, callId, reason }, "Failed to send APNs call-ended push");
          }
        })()
      );
    }

    await Promise.all(tasks);

    if (invalidTokens.length > 0) {
      await removePushTokens(userId, invalidTokens);
      if (fcmInvalidCount > 0) {
        logger.info(
          { callId, userId, removedCount: fcmInvalidCount },
          "Removed invalid FCM tokens from DB (call-ended)"
        );
      }
      if (apnsInvalidCount > 0) {
        logger.info(
          { callId, userId, removedCount: apnsInvalidCount },
          "Removed invalid APNs tokens from DB (call-ended)"
        );
      }
    }
  } catch (error) {
    logger.warn({ err: error, callId, reason }, "Failed to send call-ended push");
  }
};
