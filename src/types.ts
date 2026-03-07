/**
 * Shape of data stored under call:${callId}.
 * Incoming (domophone): channelId, endpointId, credentials, status, bridgeId, address.
 * Outgoing (app-to-app): endpointId, credentials only.
 */
export type CallData = {
  channelId?: string;
  endpointId?: string;
  credentials?: {
    sipCredentials: {
      username: string;
      password: string;
      domain: string;
    };
  };
  /** For ring-timeout: only hang up if still 'pending'. Set to 'accepted' when answered, 'rejected' on /calls/end, 'timeout' when we hang up by timeout. */
  status?: "pending" | "accepted" | "rejected" | "timeout";
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
  userId: string;
  pushToken: string;
  platform: string;
  deviceId?: string;
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

/** ARI WebSocket event shape. */
export type AriEvent = {
  type: string;
  [key: string]: unknown;
};

export type AriEventHandler = (event: AriEvent) => void;

/** ARI bridge response shape. */
export type AriBridge = {
  id: string;
};
