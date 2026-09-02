/**
 * Shape of data stored under call:${callId}.
 * Incoming (domophone): channelId, endpointId, credentials, status, bridgeId, address.
 * Outgoing (app-to-app): endpointId, credentials only.
 */
export type CallData = {
  channelId?: string;
  endpointId?: string;
  userId?: number;
  apartment?: string;
  panelIp?: string;
  credentials?: {
    sipCredentials: {
      username: string;
      password: string;
      domain: string;
    };
  };
  /** Incoming only: bridge id for cleanup. */
  bridgeId?: string;
  /** Incoming only: display address (e.g. panel address). */
  address?: string;
  /** Incoming only: panel (domophone) endpoint id for "one active incoming per panel" cleanup. */
  domophoneEndpointId?: string;
};

/**
 * Shape of data stored in channel session (StasisEnd cleanup).
 * Domophone channel: only { callId } (full call data in call:${callId}).
 * Client channel (outgoing leg): only { bridgeId }.
 */
export type ChannelSession = {
  bridgeId?: string;
  callId?: string;
};

/** Payload for /calls/credentials response (temporary SIP credentials for outgoing calls). */
export type CredentialsPayload = {
  endpointId: string;
  credentials: {
    sipCredentials: {
      username: string;
      password: string;
      domain: string;
    };
  };
};

/** Body for POST /push/register. */
export type RegisterBody = {
  userId: number | string;
  pushToken: string;
  platform: string;
};

/** FCM data message payload for incoming call push. */
export type FcmCallPayload = {
  type: "SIP_CALL";
  callId: string;
  sipCredentials: string;
  address?: string;
};

/** FCM data message payload for "call ended" push. */
export type FcmCallEndedPayload = {
  type: "SIP_CALL_ENDED";
  callId: string;
  address: string;
  reason: "timeout" | "caller_hung_up";
};

/** APNs VoIP payload for incoming call push (flat string values, same keys as FCM data). */
export type ApnsVoipCallPayload = {
  type: "SIP_CALL";
  callId: string;
  sipCredentials: string;
  address?: string;
};

/** Stored push token with platform (android FCM vs ios_voip). */
export type PushTokenRecord = {
  pushToken: string;
  platform: string;
};

/** ARI WebSocket event shape. */
export type AriEvent = {
  type: string;
  [key: string]: unknown;
};

export type AriEventHandler = (event: AriEvent) => void | Promise<void>;

/** ARI bridge response shape. */
export type AriBridge = {
  id: string;
};

/** Allowed ARI hangup reasons for DELETE /channels/{channelId}?reason=. */
export type HangupReason =
  | "normal"
  | "busy"
  | "congestion"
  | "no_answer"
  | "timeout"
  | "rejected"
  | "unallocated"
  | "normal_unspecified"
  | "number_incomplete"
  | "codec_mismatch"
  | "interworking"
  | "failure"
  | "answered_elsewhere";
