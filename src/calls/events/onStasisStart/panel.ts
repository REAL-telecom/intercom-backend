import crypto from "crypto";
import { FastifyInstance } from "fastify";
import { env } from "../../../config";
import {
  addChannelToBridge,
  continueInDialplan,
  createBridge,
  createEndpoint,
  hangupChannel,
} from "../../../ari";
import { cleanupBridge } from "../../bridges/cleanup";
import { removeTemporarySipEndpoint } from "../../endpoints";
import { sendApnsVoipPush } from "../../../push/apns";
import { sendFcmPush } from "../../../push/fcm";
import { callOutcomeToEndedReason, notifyCallOver } from "../../../push/notifyCallOver";
import {
  formatAddress,
  getAddress,
  getPanel as getPanelRecord,
  getUser,
  listPushTokens,
  removePushTokens,
} from "../../../store/postgres";
import {
  deleteOriginate,
  deletePanel as deletePanelCall,
  getCall,
  getDialStatus,
  getPanel as getPanelCall,
  listDialedChannels,
  setCall,
  setChannel,
  setDialStatus,
  setEndpoint,
  setOriginate,
  setPanel as setPanelCall,
} from "../../../store/redis";

import type { CallData } from "../../../types";

const INCOMING_MAX_CONTACTS = 8;

export const onPanelStasisStart = async (
  channel: {
    id?: string;
    name?: string;
    caller?: { number?: string; name?: string };
  },
  channelId: string,
  eventArgs: unknown[],
  app: FastifyInstance
) => {
  try {
    // Do not answer immediately - we will answer after the client channel answers
    // This is needed for proper connection setup
    app.log.info({ channelId }, "Incoming domophone channel received, will answer after client connects");

    // PJSIP channel name is like "PJSIP/endpoint_id-<uniq>"; extract endpoint_id for address lookup
    const namePart = channel.name?.split("/")[1];
    const domophoneEndpointId = namePart ? namePart.split("-")[0] : null;
    const callId = crypto.randomUUID();
    const panelIpFromArgs = typeof eventArgs[0] === "string" ? eventArgs[0].trim() : "";
    const apartmentFromArgs = typeof eventArgs[1] === "string" ? eventArgs[1].trim() : "";
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

    if (userId === null) {
      app.log.info({ callId, channelId, panelIp, apartment }, "No subscriber for incoming call, sending panel to invalid");
      try {
        await continueInDialplan(channelId, "from-domophone", "invalid", 1);
        app.log.info({ channelId, callId }, "Panel channel sent to invalid");
      } catch (continueError) {
        app.log.warn(
          { err: continueError, channelId, callId },
          "Failed to continueInDialplan panel channel to invalid"
        );
        await hangupChannel(channelId, app.log);
      }
      return;
    }

    if (domophoneEndpointId) {
      const claimed = await setPanelCall(
        domophoneEndpointId,
        callId,
        env.callTokenTtlSec
      );
      if (!claimed) {
        const existingCallId = await getPanelCall(domophoneEndpointId);
        app.log.info(
          { panelId: domophoneEndpointId, existingCallId, channelId },
          "Ignoring duplicate incoming from same panel"
        );
        const hangupResult = await hangupChannel(channelId, app.log);
        if (hangupResult === "hungUp") {
          app.log.info({ channelId }, "Hung up duplicate channel so it does not hang in Stasis");
        } else if (hangupResult === "failed") {
          app.log.warn({ channelId }, "Failed to hang up duplicate channel");
        }
        return;
      }
    }
    const endpointId = `tmp_${callId}`;
    const sipUsername = endpointId;
    const sipPassword = crypto.randomBytes(8).toString("hex");

    app.log.info({ endpointId, sipUsername, context: "intercom", maxContacts: INCOMING_MAX_CONTACTS }, "Creating temporary SIP endpoint");
    await createEndpoint({
      context: "intercom",
      id: endpointId,
      maxContacts: INCOMING_MAX_CONTACTS,
      password: sipPassword,
      username: sipUsername,
    });
    app.log.info({ endpointId }, "Temporary SIP endpoint created");
    await setEndpoint(endpointId, {}, env.callTokenTtlSec);

    // bridgeId is set only after full setup so ring push and ring timeout never run on a failed room.
    let bridgeId: string | undefined;
    let createdBridgeId: string | undefined;
    try {
      app.log.info({ callId, channelId, endpointId }, "STEP 1: Creating bridge and setting up originate");
      const bridge = await createBridge();
      createdBridgeId = bridge.id;
      app.log.info({ bridgeId: bridge.id, channelId }, "STEP 2: Bridge created, adding incoming domophone channel");
      await new Promise((r) => setTimeout(r, 300));
      await addChannelToBridge(bridge.id, channelId);
      app.log.info({ bridgeId: bridge.id, channelId }, "STEP 3: Incoming domophone channel added to bridge");

      // Single root key: full call data in call:${callId}, channel session only points to callId
      await setCall(
        callId,
        {
          channelId,
          endpointId,
          bridgeId: bridge.id,
          userId: userId ?? undefined,
          apartment: apartment ?? undefined,
          address,
          ...(domophoneEndpointId ? { domophoneEndpointId } : {}),
        },
        env.callTokenTtlSec
      );
      app.log.info({ callId, channelId, endpointId, ttlSec: env.callTokenTtlSec }, "Call data stored");
      await setChannel(channelId, { callId }, env.callTokenTtlSec);

      await setOriginate(endpointId, { bridgeId: bridge.id, channelId }, env.ringTimeoutSec);
      app.log.info({ endpointId, bridgeId: bridge.id }, "STEP 4: Pending originate stored, waiting for endpoint registration.");
      bridgeId = bridge.id;
    } catch (error) {
      app.log.error({ err: error, callId, channelId, endpointId }, "CRITICAL: Failed to setup bridge/originate - call will not connect");
      if (domophoneEndpointId) {
        try {
          await deletePanelCall(domophoneEndpointId);
          app.log.info(
            { callId, panelId: domophoneEndpointId, channelId },
            "Setup failed: cleared active incoming panel lock"
          );
        } catch (clearError) {
          app.log.warn(
            { err: clearError, callId, panelId: domophoneEndpointId, channelId },
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
      await removeTemporarySipEndpoint(endpointId, { callId, channelId, source: "setupFailed" }, app);
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
          const callDataAfterRing = await getCall<CallData>(callId);
          if (callDataAfterRing) {
            app.log.info(
              { callId, outcome: outcomeAfterRingPush, reason: endedReasonAfterRing },
              "Call ended while ring push was in flight; sending call-ended push"
            );
            await notifyCallOver(callId, callDataAfterRing, endedReasonAfterRing, app.log);
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

          const callData = await getCall<CallData>(callId);

          app.log.warn({ callId, channelId, bridgeId: capturedBridgeId, ringTimeoutSec: env.ringTimeoutSec }, "Incoming call timed out - sending domophone to noanswer");
          const claimed = await setDialStatus(callId, "timedOut", env.callTokenTtlSec);
          if (!claimed) {
            app.log.debug({ callId, channelId, bridgeId: capturedBridgeId }, "Call outcome already claimed, skipping timeout");
            return;
          }
          if (callData?.endpointId) {
            try {
              await deleteOriginate(callData.endpointId);
              app.log.info(
                { callId, endpointId: callData.endpointId },
                "Timed out: cleared pending originate"
              );
            } catch (pendingError) {
              app.log.warn(
                { err: pendingError, callId, endpointId: callData.endpointId },
                "Timed out: failed to clear pending originate"
              );
            }
          }

          try {
            await continueInDialplan(channelId, "from-domophone", "noanswer", 1);
            app.log.info({ channelId, callId }, "Timed out: domophone channel sent to noanswer");
          } catch (continueError) {
            app.log.warn({ err: continueError, channelId }, "Failed to continueInDialplan timed out channel");
          }
          const originateChannelIds = await listDialedChannels(callId);
          for (const originateChannelId of originateChannelIds) {
            if ((await hangupChannel(originateChannelId, app.log)) === "hungUp") {
              app.log.info({ callId, originateChannelId }, "Timed out: hung up originate channel");
            }
          }
          if (callData) {
            await notifyCallOver(callId, callData, "timeout", app.log);
          } else {
            app.log.warn({ callId }, "No call data for call-ended push, skipping push");
          }
          await cleanupBridge(
            capturedBridgeId,
            channelId,
            { callId, channelId, source: "timedOut" },
            app.log
          );
          if (callData?.domophoneEndpointId) {
            await deletePanelCall(callData.domophoneEndpointId);
          }
        } catch (error) {
          app.log.warn({ err: error, callId }, "Failed to auto-end timed out call");
        }
      })();
    }
  } catch (error) {
    app.log.error({ err: error }, "Failed to handle StasisStart");
  }
};
