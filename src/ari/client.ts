import WebSocket, { RawData } from "ws";
import { env } from "../config/env";

import type { AriEvent, AriEventHandler, AriBridge, HangupReason } from "../types";

/**
 * Build ARI REST base URL (no credentials in URL).
 */
const buildBaseUrl = () => {
  return `http://${env.ariHost}:${env.ariPort}/ari`;
};

/**
 * Build ARI WebSocket URL for events (no credentials in URL).
 */
const buildWsUrl = () => {
  return `ws://${env.ariHost}:${env.ariPort}/ari/events?app=${env.ariAppName}`;
};

/**
 * Build HTTP Basic Authorization header for ARI requests.
 */
const buildAuthHeader = () => {
  const token = Buffer.from(`${env.ariUser}:${env.ariPassword}`).toString("base64");
  return `Basic ${token}`;
};

/**
 * Connect to ARI WebSocket events stream.
 */
export const connectAriEvents = (onEvent: AriEventHandler) => {
  let attempts = 0;
  let current: WebSocket | null = null;

  const connect = () => {
    const ws = new WebSocket(buildWsUrl(), {
      headers: {
        Authorization: buildAuthHeader(),
      },
    });
    current = ws;

    ws.on("open", () => {
      attempts = 0;
      console.log("✅ ARI WebSocket connected successfully");
    });

    ws.on("message", (data: RawData) => {
      let event: AriEvent;
      try {
        event = JSON.parse(data.toString()) as AriEvent;
      } catch {
        console.warn("⚠️ ARI message ignored: invalid payload");
        return;
      }
      Promise.resolve()
        .then(() => onEvent(event))
        .catch((error) => {
          console.error("❌ ARI event handler failed", error);
        });
    });

    ws.on("error", (error) => {
      console.error("❌ ARI WebSocket error", error);
    });

    ws.on("close", (code, reason) => {
      const reasonText = reason ? reason.toString() : "";
      const delayMs = Math.min(30000, 1000 * 2 ** Math.min(attempts, 5));
      attempts += 1;
      console.warn(
        `⚠️ ARI WebSocket closed (code=${code}${reasonText ? `, reason=${reasonText}` : ""}); retry in ${delayMs}ms`
      );
      setTimeout(connect, delayMs);
    });

    return ws;
  };

  return connect() ?? current!;
};

const ARI_IDEMPOTENT_RETRY_COUNT = 2;
const ARI_IDEMPOTENT_RETRY_DELAY_MS = 200;
const ARI_REQUEST_TIMEOUT_MS = 10_000;

export class AriRequestError extends Error {
  readonly body: string;
  readonly status: number;

  constructor(status: number, body: string) {
    super(`ARI request failed: ${status} ${body}`);
    this.name = "AriRequestError";
    this.body = body;
    this.status = status;
  }
}

export class AriTransportError extends Error {
  readonly cause: unknown;
  readonly isTimeout: boolean;

  constructor(message: string, options: { cause: unknown; isTimeout: boolean }) {
    super(message);
    this.name = "AriTransportError";
    this.cause = options.cause;
    this.isTimeout = options.isTimeout;
  }
}

export type HangupIfExistsResult = "hung_up" | "already_gone" | "failed";

export const isAriNotFound = (error: unknown): boolean =>
  error instanceof AriRequestError && error.status === 404;

const isAriTimeoutCause = (error: unknown): boolean => {
  let current: unknown = error;
  // Node fetch wraps AbortSignal.timeout in TypeError.cause.
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    if ("name" in current && (current.name === "TimeoutError" || current.name === "AbortError")) {
      return true;
    }
    if (!("cause" in current)) {
      break;
    }
    current = current.cause;
  }
  return false;
};

const toAriTransportError = (error: unknown): AriTransportError => {
  const isTimeout = isAriTimeoutCause(error);
  const detail = error instanceof Error ? error.message : "ARI request transport failed";
  return new AriTransportError(isTimeout ? `ARI request timed out: ${detail}` : `ARI request failed: ${detail}`, {
    cause: error,
    isTimeout,
  });
};

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Perform ARI REST request.
 */
const request = async <T = unknown>(path: string, method = "GET", body?: unknown) => {
  const init: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: buildAuthHeader(),
    },
    signal: AbortSignal.timeout(ARI_REQUEST_TIMEOUT_MS),
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  try {
    const res = await fetch(`${buildBaseUrl()}${path}`, init);
    if (!res.ok) {
      const text = await res.text();
      throw new AriRequestError(res.status, text);
    }

    // Many ARI endpoints (e.g. /channels/{id}/hold) return 204 No Content.
    if (res.status === 204) {
      return undefined as T;
    }

    // Some successful ARI responses may have an empty body.
    const text = await res.text();
    if (!text) {
      return undefined as T;
    }

    // Prefer JSON parsing when possible, but don't assume every successful response has JSON.
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  } catch (error) {
    if (error instanceof AriRequestError) {
      throw error;
    }
    throw toAriTransportError(error);
  }
};

// Timeouts are not retried: aborting our wait does not free Asterisk's handler, and the request may already be running.
const isAriRetryable = (error: unknown): boolean =>
  (error instanceof AriTransportError && !error.isTimeout) ||
  (error instanceof AriRequestError && error.status >= 500);

const requestIdempotent = async <T = unknown>(path: string, method = "GET", body?: unknown): Promise<T> => {
  let lastError: unknown;
  for (let attempt = 0; attempt <= ARI_IDEMPOTENT_RETRY_COUNT; attempt++) {
    try {
      return await request<T>(path, method, body);
    } catch (error) {
      lastError = error;
      if (!isAriRetryable(error) || attempt === ARI_IDEMPOTENT_RETRY_COUNT) {
        throw error;
      }
      await delay(ARI_IDEMPOTENT_RETRY_DELAY_MS);
    }
  }
  throw lastError;
};

/**
 * Create mixing bridge for call with video support.
 */
export const createBridge = async () => {
  return request<AriBridge>("/bridges", "POST", { 
    type: "mixing",
    videoMode: "talker" // Enable video in bridge
  });
};

/**
 * Add channel to existing bridge with explicit parameters.
 */
export const addChannelToBridge = async (bridgeId: string, channelId: string) => {
  return request(`/bridges/${bridgeId}/addChannel`, "POST", {
    channel: channelId,
    role: "participant",
    absorbDTMF: false,
    mute: false,
  });
};

/**
 * Answer incoming channel (move from Ring to Up state).
 */
export const answerChannel = async (channelId: string) => {
  return request(`/channels/${channelId}/answer`, "POST");
};

/**
 * Put incoming channel on hold while waiting for user.
 */
export const holdChannel = async (channelId: string) => {
  return request(`/channels/${channelId}/hold`, "POST");
};

/**
 * Hangup channel (terminate call).
 * Optional reason is sent as a query parameter (e.g. answered_elsewhere).
 */
export const hangupChannel = async (channelId: string, reason?: HangupReason) => {
  if (reason) {
    const params = new URLSearchParams({ reason });
    return requestIdempotent(`/channels/${channelId}?${params.toString()}`, "DELETE");
  }
  return requestIdempotent(`/channels/${channelId}`, "DELETE");
};

/**
 * Hangup if the channel still exists.
 * Returns "hung_up", "already_gone" when id is missing or ARI already tore it down, or "failed".
 * Optional reason is forwarded to hangupChannel.
 */
export const hangupChannelIfExists = async (
  channelId: string | null | undefined,
  reason?: HangupReason
): Promise<HangupIfExistsResult> => {
  if (!channelId) {
    return "already_gone";
  }
  try {
    await hangupChannel(channelId, reason);
    return "hung_up";
  } catch (error) {
    if (isAriNotFound(error)) {
      return "already_gone";
    }
    const status = error instanceof AriRequestError ? error.status : undefined;
    console.warn(
      `⚠️ ARI hangup failed: channel=${channelId}${status !== undefined ? ` status=${status}` : ""}`,
      error
    );
    return "failed";
  }
};

/**
 * Exit Stasis; continue channel in dialplan at given context/extension/priority.
 * Channel leaves the bridge automatically.
 */
export const continueInDialplan = async (
  channelId: string,
  context: string,
  extension: string,
  priority: number
): Promise<void> => {
  const params = new URLSearchParams({
    context,
    extension,
    priority: String(priority),
  });
  await request(`/channels/${channelId}/continue?${params.toString()}`, "POST");
};

/**
 * Originate outgoing call to endpoint with explicit parameters.
 * appArgs may include metadata (e.g. bridge id).
 */
export const originateCall = async (endpoint: string, appArgs: string) => {
  const channel = await request<{ id?: string }>("/channels", "POST", {
    endpoint,
    app: env.ariAppName,
    appArgs,
  });
  if (!channel?.id) {
    throw new Error("ARI originate returned no channel id");
  }
  return { id: channel.id };
};

/**
 * Originate into dialplan (not Stasis). Channel variables are available in dialplan as ${VAR}.
 */
export const originateToDialplan = async (params: {
  endpoint: string;
  context: string;
  extension: string;
  priority: number;
  variables: Record<string, string>;
}) => {
  return request("/channels", "POST", {
    endpoint: params.endpoint,
    context: params.context,
    extension: params.extension,
    priority: params.priority,
    variables: params.variables,
  });
};

/**
 * Delete bridge when call ends.
 */
export const deleteBridge = async (bridgeId: string) => {
  return requestIdempotent(`/bridges/${bridgeId}`, "DELETE");
};

/**
 * Get channel information including state.
 */
export const getChannel = async (channelId: string) => {
  return request<{ id: string; state: string; name: string; caller: { number: string }; connected: { number: string } }>(
    `/channels/${channelId}`
  );
};

/**
 * List all active channels.
 */
export const listChannels = async () => {
  const channels = await request<{ id: string; name: string; creationtime: string }[]>("/channels");
  return Array.isArray(channels) ? channels : [];
};

/**
 * Get the value of a channel variable or function.
 * Unlike GET /asterisk/variable, this endpoint evaluates dialplan functions.
 * 404 means the channel or variable was not found — callers must handle that.
 */
export const getChannelVariable = async (channelId: string, variable: string): Promise<string> => {
  const params = new URLSearchParams({ variable });
  const result = await request<{ value?: string }>(
    `/channels/${channelId}/variable?${params.toString()}`
  );
  return result?.value ?? "";
};

/**
 * Get bridge information including channels.
 */
export const getBridge = async (bridgeId: string) => {
  return request<{ id: string; channels: string[]; bridge_type: string; video_mode?: string }>(
    `/bridges/${bridgeId}`
  );
};

/**
 * Delete PJSIP endpoint from Asterisk. Missing endpoint is ignored.
 */
export const deleteEndpoint = async (endpointId: string) => {
  // AOR goes first: Asterisk drops the registered contacts when the AOR is deleted.
  // Endpoint goes last: while its row exists the cleanup job still finds the object and retries.
  const objectTypes = ["aor", "auth", "endpoint"] as const;
  for (const objectType of objectTypes) {
    const path = `/asterisk/config/dynamic/res_pjsip/${objectType}/${encodeURIComponent(endpointId)}`;
    try {
      await requestIdempotent(path, "DELETE");
    } catch (error) {
      if (isAriNotFound(error)) {
        continue;
      }
      const detail =
        error instanceof AriRequestError
          ? `${error.status} ${error.body}`
          : error instanceof Error
            ? error.message
            : String(error);
      throw new Error(`ARI delete ${objectType} ${endpointId} failed: ${detail}`);
    }
  }
};
