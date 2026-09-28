import crypto from "crypto";
import { FastifyInstance } from "fastify";
import { env } from "#config";
import {
  addChannelToBridge,
  createBridge,
  createEndpoint,
  hangupChannel,
} from "#ari";
import { cleanupBridge } from "../../bridges";
import { deletePhoneEndpoint } from "../../endpoints";
import { finishCall } from "../../utils";
import { sendApnsVoipPush } from "#push/apns";
import { sendFcmPush } from "#push/fcm";
import { callOutcomeToEndedReason, notifyCallOver } from "#push/notifyCallOver";
import { listPushTokens, removePushTokens } from "#store/postgres";
import {
  clearCall,
  getCall,
  getDialStatus,
  getEndpoint,
  releaseEndpoint,
  setCall,
  setChannel,
  setDialStatus,
  setEndpoint,
  setOriginate,
} from "#store/redis";
import { onPhoneStasisStart } from "./phone";
import { readPanel, type PanelCall } from "./panel";

import type { Event } from "#ari";

const INCOMING_MAX_CONTACTS = 8;

async function assembleIncomingCall(
  channelId: string,
  callId: string,
  panelCall: PanelCall,
  app: FastifyInstance
): Promise<void> {
  const { panelId, userId, apartment, address } = panelCall;
  const phoneId = crypto.randomUUID();
  const sipUsername = phoneId;
  const sipPassword = crypto.randomBytes(8).toString("hex");
  await setCall(
    {
      id: callId,
      channelId,
      phoneId,
      userId,
      apartment,
      address,
      ...(panelId ? { panelId } : {}),
    },
    env.callTokenTtlSec
  );
  await setChannel(channelId, { callId }, env.callTokenTtlSec);
  if (panelId) {
    const claimed = await setEndpoint(
      panelId,
      { callId, type: "panel" },
      env.callTokenTtlSec,
      { nx: true }
    );
    if (!claimed) {
      const existing = await getEndpoint(panelId);
      const existingCallId = existing?.callId ?? null;
      app.log.info(
        { panelId, existingCallId, channelId },
        "Ignoring duplicate incoming from same panel"
      );
      await clearCall(callId, phoneId);
      const hangupResult = await hangupChannel(channelId, app.log);
      if (hangupResult === "hungUp") {
        app.log.info({ channelId }, "Hung up duplicate channel so it does not hang in Stasis");
      } else if (hangupResult === "failed") {
        app.log.warn({ channelId }, "Failed to hang up duplicate channel");
      }
      return;
    }
  }
  await setEndpoint(phoneId, { callId, type: "phone" }, env.callTokenTtlSec);

  // bridgeId is set only after full setup so ring push and ring timeout never run on a failed room.
  let bridgeId: string | undefined;
  let createdBridgeId: string | undefined;
  try {
    app.log.info({ phoneId, sipUsername, context: "phone", maxContacts: INCOMING_MAX_CONTACTS }, "Creating temporary SIP endpoint");
    await createEndpoint({
      context: "phone",
      id: phoneId,
      maxContacts: INCOMING_MAX_CONTACTS,
      password: sipPassword,
      username: sipUsername,
    });
    app.log.info({ phoneId }, "Temporary SIP endpoint created");
    app.log.info({ callId, channelId, phoneId }, "STEP 1: Creating bridge and setting up originate");
    const bridge = await createBridge();
    createdBridgeId = bridge.id;
    app.log.info({ bridgeId: bridge.id, channelId }, "STEP 2: Bridge created, adding incoming panel channel");
    await new Promise((r) => setTimeout(r, 300));
    await addChannelToBridge(bridge.id, channelId);
    app.log.info({ bridgeId: bridge.id, channelId }, "STEP 3: Incoming panel channel added to bridge");

    const storedCall = await getCall(callId);
    if (!storedCall) {
      throw new Error("Call record missing before bridge update");
    }
    await setCall({ ...storedCall, bridgeId: bridge.id }, env.callTokenTtlSec);
    if (panelId) {
      await setEndpoint(panelId, { callId, type: "panel" }, env.callTokenTtlSec);
    }
    await setEndpoint(phoneId, { callId, type: "phone" }, env.callTokenTtlSec);
    app.log.info({ callId, channelId, phoneId, ttlSec: env.callTokenTtlSec }, "Call data stored");
    await setOriginate(phoneId, { bridgeId: bridge.id, channelId }, env.ringTimeoutSec);
    app.log.info({ phoneId, bridgeId: bridge.id }, "STEP 4: Pending originate stored, waiting for endpoint registration.");
    bridgeId = bridge.id;
  } catch (error) {
    app.log.error({ err: error, callId, channelId, phoneId }, "CRITICAL: Failed to setup bridge/originate - call will not connect");
    if (panelId) {
      try {
        await releaseEndpoint(panelId, callId);
        app.log.info(
          { callId, panelId, channelId },
          "Setup failed: released panel lock if this call held it"
        );
      } catch (clearError) {
        app.log.warn(
          { err: clearError, callId, panelId, channelId },
          "Setup failed: failed to clear active incoming panel lock"
        );
      }
    }
    if (createdBridgeId) {
      await cleanupBridge(
        createdBridgeId,
        channelId,
        { callId, channelId, source: "setupFailed" },
        app.log
      );
    }
    await deletePhoneEndpoint(phoneId, { callId, channelId, source: "setupFailed" }, app);
    await hangupChannel(channelId, app.log);
  }

  // Ring push + ring timeout only when the room was fully assembled.
  if (bridgeId) {
    const outcomeBeforeRingPush = await getDialStatus(callId);
    if (outcomeBeforeRingPush !== null) {
      app.log.info(
        { callId, outcome: outcomeBeforeRingPush },
        "Skipping ring push: call outcome already claimed"
      );
    } else {
      const records = await listPushTokens(userId);
      app.log.info({ tokensCount: records.length, userId }, "Push tokens retrieved");
      if (records.length === 0) {
        app.log.warn({ userId }, "No push tokens for user");
      } else {
        const androidTokens = records.filter((r) => r.platform === "android").map((r) => r.pushToken);
        const iosVoipTokens = records.filter((r) => r.platform === "ios_voip").map((r) => r.pushToken);
        const sipCredentials = { username: sipUsername, password: sipPassword, domain: env.serverDomain };
        const callPayload = {
          type: "SIP_CALL" as const,
          callId,
          sipCredentials: JSON.stringify(sipCredentials),
          address,
        };
        const invalidTokens: string[] = [];
        let fcmInvalidCount = 0;
        let apnsInvalidCount = 0;
        const ringPushTasks: Promise<void>[] = [];
        if (androidTokens.length > 0) {
          app.log.info({ callId, tokensCount: androidTokens.length }, "Sending FCM push (call, data-only)");
          ringPushTasks.push(
            (async () => {
              try {
                const { invalidTokens: fcmInvalid } = await sendFcmPush(androidTokens, callPayload);
                fcmInvalidCount = fcmInvalid.length;
                invalidTokens.push(...fcmInvalid);
                app.log.info({ callId, tokensCount: androidTokens.length }, "FCM push (call) sent");
              } catch (pushError) {
                app.log.error({ err: pushError, callId }, "FCM push failed, continuing call setup (timeout will still run)");
              }
            })()
          );
        }
        if (iosVoipTokens.length > 0) {
          app.log.info({ callId, tokensCount: iosVoipTokens.length }, "Sending APNs VoIP push (call)");
          ringPushTasks.push(
            (async () => {
              try {
                const { invalidTokens: apnsInvalid } = await sendApnsVoipPush(iosVoipTokens, callPayload);
                apnsInvalidCount = apnsInvalid.length;
                invalidTokens.push(...apnsInvalid);
                app.log.info({ callId, tokensCount: iosVoipTokens.length }, "APNs VoIP push (call) sent");
              } catch (pushError) {
                app.log.error({ err: pushError, callId }, "APNs VoIP push failed, continuing call setup (timeout will still run)");
              }
            })()
          );
        }
        await Promise.all(ringPushTasks);
        if (invalidTokens.length > 0) {
          await removePushTokens(userId, invalidTokens);
          if (fcmInvalidCount > 0) {
            app.log.info({ callId, userId, removedCount: fcmInvalidCount }, "Removed invalid FCM tokens from DB");
          }
          if (apnsInvalidCount > 0) {
            app.log.info({ callId, userId, removedCount: apnsInvalidCount }, "Removed invalid APNs tokens from DB");
          }
        }
        const outcomeAfterRingPush = await getDialStatus(callId);
        const endedReasonAfterRing = callOutcomeToEndedReason(outcomeAfterRingPush);
        if (endedReasonAfterRing !== null) {
          const callAfterRing = await getCall(callId);
          if (callAfterRing) {
            app.log.info(
              { callId: callAfterRing.id, outcome: outcomeAfterRingPush, reason: endedReasonAfterRing },
              "Call ended while ring push was in flight; sending call-ended push"
            );
            await notifyCallOver(callAfterRing, endedReasonAfterRing, app.log);
          }
        }
      }
    }

    // If nobody answers, auto-end the call on backend after ring timeout.
    const capturedBridgeId = bridgeId;
    void (async () => {
      try {
        await new Promise((r) => setTimeout(r, env.ringTimeoutSec * 1000));
        const outcome = await getDialStatus(callId);
        if (outcome !== null) {
          app.log.debug({ callId, channelId, bridgeId: capturedBridgeId, outcome }, "Call already processed, skipping timeout");
          return;
        }

        const call = await getCall(callId);

        app.log.warn({ callId, channelId, bridgeId: capturedBridgeId, ringTimeoutSec: env.ringTimeoutSec }, "Incoming call timed out - sending panel to noanswer");
        const claimed = await setDialStatus(callId, "timedOut", env.callTokenTtlSec);
        if (!claimed) {
          app.log.debug({ callId, channelId, bridgeId: capturedBridgeId }, "Call outcome already claimed, skipping timeout");
          return;
        }
        if (call) {
          await notifyCallOver(call, "timeout", app.log);
          await finishCall(call, "noanswer", "timedOut", app.log, app);
        } else {
          app.log.warn({ callId }, "No call data for call-ended push, skipping push");
        }
      } catch (error) {
        app.log.warn({ err: error, callId }, "Failed to auto-end timed out call");
      }
    })();
  }
}

export const onStasisStart = async (event: Event, app: FastifyInstance) => {
  app.log.info({ fullEvent: JSON.stringify(event) }, "StasisStart event - full data");
  const channel = event.channel as {
    id?: string;
    name?: string;
    caller?: { number?: string; name?: string };
  };
  if (!channel.id) {
    app.log.warn({ event }, "StasisStart event without channel.id");
    return;
  }
  const channelId = channel.id;
  const eventArgs = Array.isArray((event as { args?: unknown[] }).args)
    ? ((event as { args?: unknown[] }).args as unknown[])
    : [];
  if (eventArgs[0] === "phone") {
    await onPhoneStasisStart(event, channelId, eventArgs, app);
    return;
  }
  if (eventArgs[0] === "panel") {
    // Do not answer immediately - we will answer after the client channel answers
    // This is needed for proper connection setup
    app.log.info({ channelId }, "Incoming panel channel received, will answer after client connects");
    const callId = crypto.randomUUID();
    try {
      const panelCall = await readPanel(channel, channelId, eventArgs, callId, app);
      if (!panelCall) {
        return;
      }
      await assembleIncomingCall(channelId, callId, panelCall, app);
    } catch (error) {
      app.log.error({ err: error }, "Failed to handle StasisStart");
    }
    return;
  }
  app.log.warn({ channelId, args: eventArgs }, "StasisStart ignored: unknown marker");
};
