import * as fs from "fs";
import * as http2 from "http2";
import jwt from "jsonwebtoken";
import { env } from "../config/env";

import type { ApnsVoipCallPayload } from "../types";

const JWT_MAX_AGE_MS = 55 * 60 * 1000;
const JWT_MIN_REISSUE_MS = 20 * 60 * 1000;
const APNS_REQUEST_TIMEOUT_MS = 10_000;

let apnsKeyPem: string | undefined;
let cachedJwt: string | undefined;
let cachedJwtAtMs = 0;
let unconfiguredWarningLogged = false;
let apnsSession: http2.ClientHttp2Session | undefined;

/**
 * True when all required APNs env vars are non-empty.
 * Missing config must not crash the process.
 */
function isApnsConfigured(): boolean {
  return (
    env.apns.keyPath.length > 0 &&
    env.apns.keyId.length > 0 &&
    env.apns.teamId.length > 0 &&
    env.apns.bundleId.length > 0
  );
}

/**
 * APNs host for the configured environment (sandbox unless production).
 */
function getApnsHost(): string {
  return env.apns.environment === "production"
    ? "api.push.apple.com"
    : "api.sandbox.push.apple.com";
}

/**
 * Load the .p8 key from disk once (lazy, same idea as ensureFirebase).
 */
function loadApnsKeyPem(): string {
  if (apnsKeyPem !== undefined) return apnsKeyPem;
  apnsKeyPem = fs.readFileSync(env.apns.keyPath, "utf8");
  return apnsKeyPem;
}

/**
 * Sign (or reuse) an ES256 JWT for APNs.
 * Reissues no more than once per 20 minutes and no later than 55 minutes.
 */
function getApnsJwt(): string {
  const now = Date.now();
  const ageMs = now - cachedJwtAtMs;
  if (cachedJwt !== undefined) {
    if (ageMs < JWT_MIN_REISSUE_MS) {
      return cachedJwt;
    }
    if (ageMs < JWT_MAX_AGE_MS) {
      return cachedJwt;
    }
  }

  const token = jwt.sign(
    { iss: env.apns.teamId, iat: Math.floor(now / 1000) },
    loadApnsKeyPem(),
    {
      algorithm: "ES256",
      header: { alg: "ES256", kid: env.apns.keyId },
    }
  );
  cachedJwt = token;
  cachedJwtAtMs = now;
  return token;
}

/**
 * Reuse an HTTP/2 session to APNs, reconnecting if it was closed.
 */
function getApnsSession(): Promise<http2.ClientHttp2Session> {
  const existing = apnsSession;
  if (existing && !existing.closed && !existing.destroyed) {
    if (!existing.connecting) {
      return Promise.resolve(existing);
    }
    return waitForSessionConnect(existing);
  }

  const session = http2.connect(`https://${getApnsHost()}:443`);
  apnsSession = session;
  session.on("error", (err) => {
    console.error("APNs HTTP/2 session error", err);
    if (apnsSession === session) {
      apnsSession = undefined;
    }
  });
  session.on("close", () => {
    if (apnsSession === session) {
      apnsSession = undefined;
    }
  });
  return waitForSessionConnect(session);
}

/**
 * Resolve when the HTTP/2 session is connected (or reject on error).
 */
function waitForSessionConnect(
  session: http2.ClientHttp2Session
): Promise<http2.ClientHttp2Session> {
  if (!session.connecting) {
    return Promise.resolve(session);
  }
  return new Promise((resolve, reject) => {
    const onConnect = () => {
      session.off("error", onError);
      resolve(session);
    };
    const onError = (err: Error) => {
      session.off("connect", onConnect);
      reject(err);
    };
    session.once("connect", onConnect);
    session.once("error", onError);
  });
}

/**
 * POST a VoIP payload to one device token. Caller interprets status.
 */
function sendApnsRequest(
  token: string,
  body: Record<string, string>
): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    void getApnsSession()
      .then((session) => {
        const req = session.request({
          ":method": "POST",
          ":path": `/3/device/${token}`,
          authorization: `bearer ${getApnsJwt()}`,
          "apns-topic": `${env.apns.bundleId}.voip`,
          "apns-push-type": "voip",
          "apns-priority": "10",
          "apns-expiration": "0",
          "content-type": "application/json",
        });

        const chunks: Buffer[] = [];
        let status = 0;

        req.setTimeout(APNS_REQUEST_TIMEOUT_MS, () => {
          req.close();
          reject(new Error("APNs request timeout"));
        });
        req.on("response", (headers) => {
          const rawStatus = headers[":status"];
          status = typeof rawStatus === "number" ? rawStatus : Number(rawStatus);
        });
        req.on("data", (chunk: Buffer | string) => {
          chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        });
        req.on("end", () => {
          resolve({ status, data: Buffer.concat(chunks).toString("utf8") });
        });
        req.on("error", reject);
        req.end(JSON.stringify(body));
      })
      .catch(reject);
  });
}

/**
 * True when APNs says this device token must be dropped.
 */
function isInvalidDeviceToken(status: number, responseBody: string): boolean {
  if (status === 410) return true;
  if (status !== 400) return false;
  try {
    const parsed = JSON.parse(responseBody) as { reason?: string };
    return parsed.reason === "BadDeviceToken";
  } catch {
    return false;
  }
}

/**
 * Send the same flat JSON body to each VoIP token. Does not throw on partial failure.
 */
async function sendApns(
  tokens: string[],
  body: Record<string, string>
): Promise<{ invalidTokens: string[] }> {
  const invalidTokens: string[] = [];
  if (tokens.length === 0) return { invalidTokens };

  if (!isApnsConfigured()) {
    if (!unconfiguredWarningLogged) {
      unconfiguredWarningLogged = true;
      console.warn(
        "APNs is not configured (APNS_KEY_PATH, APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID); skipping VoIP push"
      );
    }
    return { invalidTokens };
  }

  for (const token of tokens) {
    try {
      const result = await sendApnsRequest(token, body);
      if (isInvalidDeviceToken(result.status, result.data)) {
        invalidTokens.push(token);
      } else if (result.status >= 400) {
        console.error("APNs VoIP push rejected", {
          status: result.status,
          body: result.data,
          tokenPrefix: token.slice(0, 8),
        });
      }
    } catch (err) {
      console.error("APNs VoIP push request failed", {
        err,
        tokenPrefix: token.slice(0, 8),
      });
    }
  }

  return { invalidTokens };
}

/**
 * Send PushKit VoIP push for an incoming SIP call.
 * Returns invalid tokens to remove from DB. Does not throw on partial failure.
 */
export const sendApnsVoipPush = async (
  tokens: string[],
  payload: ApnsVoipCallPayload
): Promise<{ invalidTokens: string[] }> => {
  const body: Record<string, string> = {
    type: payload.type,
    callId: payload.callId,
    sipCredentials: payload.sipCredentials,
  };
  if (payload.address != null && payload.address !== "") {
    body.address = payload.address;
  }
  return sendApns(tokens, body);
};
