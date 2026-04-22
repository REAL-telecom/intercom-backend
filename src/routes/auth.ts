import crypto from "crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FastifyInstance } from "fastify";
import { getOrCreateUser } from "../store/postgres";
import {
  blockOtpRequestByIp,
  blockOtpRequestByPhone,
  blockOtpVerifyByIp,
  blockOtpVerifyByPhone,
  deleteOtp,
  enqueueOtpCall,
  getOtp,
  incrementOtpRequestCounterByIp,
  incrementOtpRequestCounterByPhone,
  incrementOtpVerifyCounterByIp,
  incrementOtpVerifyCounterByPhone,
  isOtpCallQueued,
  isOtpRequestBlockedByIp,
  isOtpRequestBlockedByPhone,
  isOtpVerifyBlockedByIp,
  isOtpVerifyBlockedByPhone,
  resetOtpRateLimitsForIpAndPhone,
  resetOtpRequestRateLimitsForIpAndPhone,
  resetOtpVerifyRateLimitsForIpAndPhone,
  setOtp,
} from "../store/redis";

const execFileAsync = promisify(execFile);

const OTP_TTL_SEC = 300;

const REQUEST_LIMIT_WINDOW_SEC = 1200;
const VERIFY_LIMIT_WINDOW_SEC = 1200;
const LIMIT_MAX_ATTEMPTS = 5;
const BLOCK_TTL_SEC = 300;

const FAIL2BAN_DB_PATH = "/var/lib/fail2ban/fail2ban.sqlite3";
const FAIL2BAN_BACKEND_JAIL = "auth-combined";

const MSG_PHONE_REQUIRED = "Укажите номер телефона.";
const MSG_PHONE_INVALID = "Некорректный номер телефона.";
const MSG_PIN_FORMAT_INVALID = "Некорректный формат пина.";
const MSG_RATE_LIMITED = "Превышен лимит запросов.";
const MSG_ALREADY_QUEUED = "Звонок уже в очереди.";
const MSG_REQUEST_ACCEPTED = "Запрос на звонок принят.";
const MSG_CODE_EXPIRED = "Срок кода истек.";
const MSG_PIN_CONFIRMED = "Пин подтверждён.";

type LogLevel = "info" | "warn";

const nowUnixSec = (): number => Math.floor(Date.now() / 1000);

/**
 * Write auth log line in a fail2ban-friendly format.
 */
const logAuthLine = (
  app: FastifyInstance,
  level: LogLevel,
  tag: string,
  message: string,
  ip: string,
  phone: string,
  route: string
) => {
  const line = `[${tag}] ${message} ip=${ip} phone=${phone} route=${route}`;
  app.log[level](line);
};

/**
 * Escape SQL string literal for sqlite3 CLI query.
 */
const toSqlLiteral = (value: string): string => {
  return `'${value.replace(/'/g, "''")}'`;
};

/**
 * Check whether IP is currently banned for backend jail in fail2ban SQLite.
 */
const isBackendIpBanned = async (ip: string, app: FastifyInstance): Promise<boolean> => {
  const jail = toSqlLiteral(FAIL2BAN_BACKEND_JAIL);
  const ipLiteral = toSqlLiteral(ip);

  const sql = [
    "SELECT CASE WHEN EXISTS (",
    "  SELECT 1",
    "  FROM bans",
    `  WHERE jail = ${jail}`,
    `    AND ip = ${ipLiteral}`,
    "    AND (bantime = -1 OR timeofban + bantime > strftime('%s','now'))",
    "  LIMIT 1",
    ") THEN 1 ELSE 0 END;",
  ].join(" ");

  try {
    const { stdout } = await execFileAsync("sqlite3", [FAIL2BAN_DB_PATH, sql]);
    return stdout.trim() === "1";
  } catch (err) {
    app.log.warn({ err }, "auth fail2ban sqlite check failed");
    return false;
  }
};

/**
 * Normalize phone to E.164-like local canonical format: 7XXXXXXXXXX.
 * Accepts +7XXXXXXXXXX / 7XXXXXXXXXX / 10-digit local numbers.
 */
const normalizePhone = (raw: string): string | null => {
  const d = raw.replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("7")) return d;
  if (d.length === 10) return `7${d}`;
  return null;
};

/**
 * Register phone authorization routes:
 * - POST /auth/request-code
 * - POST /auth/verify-code
 */
export const registerAuthRoutes = async (app: FastifyInstance) => {
  /**
   * Generate 5-digit code, store it in Redis with TTL, and enqueue OTP call.
   */
  app.post<{ Body: { phone?: string } }>("/auth/request-code", async (request, reply) => {
    const route = "/auth/request-code";
    const ip = request.ip;
    const raw = request.body?.phone?.trim();
    if (!raw) {
      logAuthLine(app, "warn", "AUTH_REQ_INVALID", MSG_PHONE_REQUIRED, ip, "-", route);
      return reply.code(400).send({ success: false, message: MSG_PHONE_REQUIRED });
    }

    const phone = normalizePhone(raw);
    if (!phone) {
      logAuthLine(app, "warn", "AUTH_REQ_INVALID", MSG_PHONE_INVALID, ip, raw, route);
      return reply.code(400).send({ success: false, message: MSG_PHONE_INVALID });
    }

    if ((await isOtpRequestBlockedByIp(ip)) || (await isOtpRequestBlockedByPhone(phone))) {
      logAuthLine(app, "warn", "AUTH_REQ_RATE_LIMITED", MSG_RATE_LIMITED, ip, phone, route);
      return reply.header("Retry-After", String(BLOCK_TTL_SEC)).code(429).send({
        success: false,
        message: MSG_RATE_LIMITED,
        blockExpiresAt: nowUnixSec() + BLOCK_TTL_SEC,
      });
    }

    const reqByIp = await incrementOtpRequestCounterByIp(ip, REQUEST_LIMIT_WINDOW_SEC);
    const reqByPhone = await incrementOtpRequestCounterByPhone(phone, REQUEST_LIMIT_WINDOW_SEC);
    if (reqByIp >= LIMIT_MAX_ATTEMPTS || reqByPhone >= LIMIT_MAX_ATTEMPTS) {
      await Promise.all([blockOtpRequestByIp(ip, BLOCK_TTL_SEC), blockOtpRequestByPhone(phone, BLOCK_TTL_SEC)]);
      await resetOtpRequestRateLimitsForIpAndPhone(ip, phone);
      logAuthLine(app, "warn", "AUTH_REQ_RATE_LIMITED", MSG_RATE_LIMITED, ip, phone, route);
      return reply.header("Retry-After", String(BLOCK_TTL_SEC)).code(429).send({
        success: false,
        message: MSG_RATE_LIMITED,
        blockExpiresAt: nowUnixSec() + BLOCK_TTL_SEC,
      });
    }

    if (await isBackendIpBanned(ip, app)) {
      logAuthLine(app, "warn", "AUTH_REQ_RATE_LIMITED", MSG_RATE_LIMITED, ip, phone, route);
      return reply.header("Retry-After", String(BLOCK_TTL_SEC)).code(429).send({
        success: false,
        message: MSG_RATE_LIMITED,
        blockExpiresAt: nowUnixSec() + BLOCK_TTL_SEC,
      });
    }

    const existingCode = await getOtp(phone);
    if (existingCode || (await isOtpCallQueued(phone))) {
      if (existingCode) {
        await setOtp(phone, existingCode, OTP_TTL_SEC);
      }
      logAuthLine(app, "info", "AUTH_REQ_QUEUED", MSG_ALREADY_QUEUED, ip, phone, route);
      return reply.code(200).send({
        success: true,
        message: MSG_ALREADY_QUEUED,
        nextRequestAvailableAt: nowUnixSec() + 60,
      });
    }

    const code = String(crypto.randomInt(0, 100_000)).padStart(5, "0");
    await setOtp(phone, code, OTP_TTL_SEC);
    const queued = await enqueueOtpCall({ phone, ip });
    if (!queued) {
      logAuthLine(app, "info", "AUTH_REQ_QUEUED", MSG_ALREADY_QUEUED, ip, phone, route);
      return reply.code(200).send({
        success: true,
        message: MSG_ALREADY_QUEUED,
        nextRequestAvailableAt: nowUnixSec() + 60,
      });
    }

    logAuthLine(app, "info", "AUTH_REQ_ACCEPTED", MSG_REQUEST_ACCEPTED, ip, phone, route);
    return reply.code(200).send({
      success: true,
      message: MSG_REQUEST_ACCEPTED,
      nextRequestAvailableAt: nowUnixSec() + 60,
    });
  });

  /**
   * Validate phone + code pair against Redis and create user row on success.
   */
  app.post<{ Body: { phone?: string; code?: string } }>("/auth/verify-code", async (request, reply) => {
    const route = "/auth/verify-code";
    const ip = request.ip;
    const raw = request.body?.phone?.trim();
    const codeIn = request.body?.code?.trim();
    if (!raw || codeIn === undefined || codeIn === "") {
      logAuthLine(app, "warn", "AUTH_VERIFY_INVALID", MSG_PHONE_REQUIRED, ip, "-", route);
      return reply.code(400).send({ success: false, message: MSG_PHONE_REQUIRED });
    }

    const phone = normalizePhone(raw);
    if (!phone) {
      logAuthLine(app, "warn", "AUTH_VERIFY_INVALID", MSG_PHONE_INVALID, ip, raw, route);
      return reply.code(400).send({ success: false, message: MSG_PHONE_INVALID });
    }

    if ((await isOtpVerifyBlockedByIp(ip)) || (await isOtpVerifyBlockedByPhone(phone))) {
      logAuthLine(app, "warn", "AUTH_VERIFY_RATE_LIMITED", MSG_RATE_LIMITED, ip, phone, route);
      return reply.header("Retry-After", String(BLOCK_TTL_SEC)).code(429).send({
        success: false,
        message: MSG_RATE_LIMITED,
        blockExpiresAt: nowUnixSec() + BLOCK_TTL_SEC,
      });
    }

    if (!/^\d{5}$/.test(codeIn)) {
      logAuthLine(app, "warn", "AUTH_VERIFY_INVALID", MSG_PIN_FORMAT_INVALID, ip, phone, route);
      return reply.code(400).send({ success: false, message: MSG_PIN_FORMAT_INVALID });
    }

    if (await isBackendIpBanned(ip, app)) {
      logAuthLine(app, "warn", "AUTH_VERIFY_RATE_LIMITED", MSG_RATE_LIMITED, ip, phone, route);
      return reply.header("Retry-After", String(BLOCK_TTL_SEC)).code(429).send({
        success: false,
        message: MSG_RATE_LIMITED,
        blockExpiresAt: nowUnixSec() + BLOCK_TTL_SEC,
      });
    }

    const expected = await getOtp(phone);
    if (!expected) {
      logAuthLine(app, "warn", "AUTH_VERIFY_EXPIRED", MSG_CODE_EXPIRED, ip, phone, route);
      return reply.code(410).send({ success: false, message: MSG_CODE_EXPIRED });
    }

    if (expected !== codeIn) {
      const verifyByIp = await incrementOtpVerifyCounterByIp(ip, VERIFY_LIMIT_WINDOW_SEC);
      const verifyByPhone = await incrementOtpVerifyCounterByPhone(phone, VERIFY_LIMIT_WINDOW_SEC);
      if (verifyByIp >= LIMIT_MAX_ATTEMPTS || verifyByPhone >= LIMIT_MAX_ATTEMPTS) {
        await Promise.all([blockOtpVerifyByIp(ip, BLOCK_TTL_SEC), blockOtpVerifyByPhone(phone, BLOCK_TTL_SEC)]);
        await resetOtpVerifyRateLimitsForIpAndPhone(ip, phone);
        logAuthLine(app, "warn", "AUTH_VERIFY_RATE_LIMITED", MSG_RATE_LIMITED, ip, phone, route);
        return reply.header("Retry-After", String(BLOCK_TTL_SEC)).code(429).send({
          success: false,
          message: MSG_RATE_LIMITED,
          blockExpiresAt: nowUnixSec() + BLOCK_TTL_SEC,
        });
      }

      const attempt = Math.min(Math.max(verifyByIp, verifyByPhone), LIMIT_MAX_ATTEMPTS);
      const attemptsLeft = Math.max(0, LIMIT_MAX_ATTEMPTS - attempt);
      const message = `Некорректный пин. Осталось попыток: ${attemptsLeft}.`;
      logAuthLine(app, "warn", "AUTH_VERIFY_WRONG_CODE", message, ip, phone, route);
      return reply.code(400).send({ success: false, message });
    }

    const user = await getOrCreateUser(phone);
    await deleteOtp(phone);
    await resetOtpRateLimitsForIpAndPhone(ip, phone);
    logAuthLine(app, "info", "AUTH_VERIFY_SUCCESS", MSG_PIN_CONFIRMED, ip, phone, route);
    return reply.code(200).send({ success: true, message: MSG_PIN_CONFIRMED, user });
  });
};
