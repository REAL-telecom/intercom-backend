import crypto from "crypto";
import { FastifyInstance } from "fastify";
import { getOrCreateUser } from "../store/postgres";
import {
  blockOtpRequestByIp,
  blockOtpVerifyByIp,
  deleteOtp,
  enqueueOtpCall,
  getOtp,
  getOtpRequestCounterByIp,
  getOtpVerifyCounterByIp,
  incrementOtpRequestCounterByIp,
  incrementOtpRequestCounterByPhone,
  incrementOtpRequestUniquePhoneCounterByIp,
  incrementOtpVerifyCounterByIp,
  incrementOtpVerifyCounterByPhone,
  isOtpCallQueued,
  isOtpRequestBlockedByIp,
  isOtpVerifyBlockedByIp,
  refreshOtpRequestCounterByPhoneTTL,
  resetOtpRateLimitsForIpAndPhone,
  setOtp,
} from "../store/redis";

const OTP_TTL = 300;
const IP_RATE_LIMIT_TTL = 900;
const IP_LIMIT_ATTEMPTS = 10;
const PHONE_RATE_LIMIT_TTL = 300;
const PHONE_LIMIT_ATTEMPTS = 5;

const MSG_IP_BLOCKED = "IP заблокирован";
const MSG_PHONE_INVALID = "Некорректный номер телефона";
const MSG_PIN_CONFIRMED = "Пин подтверждён";
const MSG_PIN_EXPIRED = "Код устарел";
const MSG_PIN_INVALID = "Неверный код";
const MSG_RATE_LIMITED = "Превышен лимит запросов";
const MSG_REQUEST_ACCEPTED = "Запрос на звонок принят";
const MSG_REQUEST_QUEUED = "Запрос в очереди";


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
   * On success, responses include pinExpiresAt (Unix seconds): deadline after which
   * the current OTP for this phone is no longer valid (aligned with Redis OTP TTL).
   */
  app.post<{ Body: { phone?: string } }>("/auth/request-code", async (request, reply) => {
    const route = "/auth/request-code";
    const ip = request.ip;
    const raw = request.body?.phone?.trim();
    if (!raw) {
      logAuthLine(app, "warn", "AUTH_REQ_INVALID", MSG_PHONE_INVALID, ip, "-", route);
      return reply.code(400).send({ success: false, message: MSG_PHONE_INVALID });
    }

    const phone = normalizePhone(raw);
    if (!phone) {
      logAuthLine(app, "warn", "AUTH_REQ_INVALID", MSG_PHONE_INVALID, ip, raw, route);
      return reply.code(400).send({ success: false, message: MSG_PHONE_INVALID });
    }

    if ((await isOtpRequestBlockedByIp(ip)) || (await isOtpVerifyBlockedByIp(ip))) {
      logAuthLine(app, "warn", "AUTH_BLOCK", MSG_IP_BLOCKED, ip, phone, route);
      return reply.code(429).send({
        success: false,
        message: MSG_IP_BLOCKED,
      });
    }

    const uniquePhonesByIp = await incrementOtpRequestUniquePhoneCounterByIp(ip, phone, IP_RATE_LIMIT_TTL);
    if (uniquePhonesByIp >= PHONE_LIMIT_ATTEMPTS) {
      await resetOtpRateLimitsForIpAndPhone(ip, phone);
      await Promise.all([
        blockOtpRequestByIp(ip, IP_RATE_LIMIT_TTL),
        blockOtpVerifyByIp(ip, IP_RATE_LIMIT_TTL),
      ]);
      logAuthLine(app, "warn", "AUTH_BLOCK", MSG_IP_BLOCKED, ip, phone, route);
      return reply.code(429).send({
        success: false,
        message: MSG_IP_BLOCKED,
      });
    }

    const reqByIp = await incrementOtpRequestCounterByIp(ip, IP_RATE_LIMIT_TTL);
    if (reqByIp + (await getOtpVerifyCounterByIp(ip)) >= IP_LIMIT_ATTEMPTS) {
      await resetOtpRateLimitsForIpAndPhone(ip, phone);
      await Promise.all([
        blockOtpRequestByIp(ip, IP_RATE_LIMIT_TTL),
        blockOtpVerifyByIp(ip, IP_RATE_LIMIT_TTL),
      ]);
      logAuthLine(app, "warn", "AUTH_BLOCK", MSG_IP_BLOCKED, ip, phone, route);
      return reply.code(429).send({
        success: false,
        message: MSG_IP_BLOCKED,
      });
    }

    const reqByPhone = await incrementOtpRequestCounterByPhone(phone, PHONE_RATE_LIMIT_TTL);
    if (reqByPhone >= IP_LIMIT_ATTEMPTS) {
      await resetOtpRateLimitsForIpAndPhone(ip, phone);
      await Promise.all([
        blockOtpRequestByIp(ip, IP_RATE_LIMIT_TTL),
        blockOtpVerifyByIp(ip, IP_RATE_LIMIT_TTL),
      ]);
      logAuthLine(app, "warn", "AUTH_BLOCK", MSG_IP_BLOCKED, ip, phone, route);
      return reply.code(429).send({
        success: false,
        message: MSG_IP_BLOCKED,
      });
    }

    if (reqByPhone >= PHONE_LIMIT_ATTEMPTS) {
      if (reqByPhone === PHONE_LIMIT_ATTEMPTS) {
        await refreshOtpRequestCounterByPhoneTTL(phone, PHONE_RATE_LIMIT_TTL);
      }
      logAuthLine(app, "warn", "AUTH_REQ_RATE_LIMITED", MSG_RATE_LIMITED, ip, phone, route);
      return reply.header("Retry-After", String(PHONE_RATE_LIMIT_TTL)).code(429).send({
        success: false,
        message: MSG_RATE_LIMITED,
        blockExpiresAt: nowUnixSec() + PHONE_RATE_LIMIT_TTL,
      });
    }

    const existingCode = await getOtp(phone);
    if (existingCode || (await isOtpCallQueued(phone))) {
      if (existingCode) {
        await setOtp(phone, existingCode, OTP_TTL);
      }
      logAuthLine(app, "info", "AUTH_REQ_QUEUED", MSG_REQUEST_QUEUED, ip, phone, route);
      return reply.code(200).send({
        success: true,
        message: MSG_REQUEST_QUEUED,
        nextRequestAvailableAt: nowUnixSec() + 60,
        pinExpiresAt: nowUnixSec() + OTP_TTL,
      });
    }

    const code = String(crypto.randomInt(0, 100_000)).padStart(5, "0");
    await setOtp(phone, code, OTP_TTL);
    const queued = await enqueueOtpCall({ phone, ip });
    if (!queued) {
      logAuthLine(app, "info", "AUTH_REQ_QUEUED", MSG_REQUEST_QUEUED, ip, phone, route);
      return reply.code(200).send({
        success: true,
        message: MSG_REQUEST_QUEUED,
        nextRequestAvailableAt: nowUnixSec() + 60,
        pinExpiresAt: nowUnixSec() + OTP_TTL,
      });
    }

    logAuthLine(app, "info", "AUTH_REQ_ACCEPTED", MSG_REQUEST_ACCEPTED, ip, phone, route);
    return reply.code(200).send({
      success: true,
      message: MSG_REQUEST_ACCEPTED,
      nextRequestAvailableAt: nowUnixSec() + 60,
      pinExpiresAt: nowUnixSec() + OTP_TTL,
    });
  });

  /**
   * Validate phone + code pair against Redis and create user row on success.
   * Expired OTP attempts count toward the same verify rate limits as wrong PIN.
   */
  app.post<{ Body: { phone?: string; code?: string } }>("/auth/verify-code", async (request, reply) => {
    const route = "/auth/verify-code";
    const ip = request.ip;
    const raw = request.body?.phone?.trim();
    const codeIn = request.body?.code?.trim();
    if (!raw) {
      logAuthLine(app, "warn", "AUTH_VERIFY_INVALID", MSG_PHONE_INVALID, ip, "-", route);
      return reply.code(400).send({ success: false, message: MSG_PHONE_INVALID });
    }

    const phone = normalizePhone(raw);
    if (!phone) {
      logAuthLine(app, "warn", "AUTH_VERIFY_INVALID", MSG_PHONE_INVALID, ip, raw, route);
      return reply.code(400).send({ success: false, message: MSG_PHONE_INVALID });
    }

    if ((await isOtpRequestBlockedByIp(ip)) || (await isOtpVerifyBlockedByIp(ip))) {
      logAuthLine(app, "warn", "AUTH_BLOCK", MSG_IP_BLOCKED, ip, phone, route);
      return reply.code(429).send({
        success: false,
        message: MSG_IP_BLOCKED,
      });
    }

    const verifyByIp = await incrementOtpVerifyCounterByIp(ip, IP_RATE_LIMIT_TTL);
    if (verifyByIp + (await getOtpRequestCounterByIp(ip)) > IP_LIMIT_ATTEMPTS) {
      await resetOtpRateLimitsForIpAndPhone(ip, phone);
      await Promise.all([
        blockOtpRequestByIp(ip, IP_RATE_LIMIT_TTL),
        blockOtpVerifyByIp(ip, IP_RATE_LIMIT_TTL),
      ]);
      logAuthLine(app, "warn", "AUTH_BLOCK", MSG_IP_BLOCKED, ip, phone, route);
      return reply.code(429).send({
        success: false,
        message: MSG_IP_BLOCKED,
      });
    }

    const verifyByPhone = await incrementOtpVerifyCounterByPhone(phone, PHONE_RATE_LIMIT_TTL);
    const applyVerifyLimits = async () => {
      if (verifyByPhone >= IP_LIMIT_ATTEMPTS) {
        await resetOtpRateLimitsForIpAndPhone(ip, phone);
        await Promise.all([
          blockOtpRequestByIp(ip, IP_RATE_LIMIT_TTL),
          blockOtpVerifyByIp(ip, IP_RATE_LIMIT_TTL),
        ]);
        logAuthLine(app, "warn", "AUTH_BLOCK", MSG_IP_BLOCKED, ip, phone, route);
        return reply.code(429).send({
          success: false,
          message: MSG_IP_BLOCKED,
        });
      }
      if (verifyByPhone >= PHONE_LIMIT_ATTEMPTS) {
        logAuthLine(app, "warn", "AUTH_VERIFY_RATE_LIMITED", MSG_RATE_LIMITED, ip, phone, route);
        return reply.header("Retry-After", String(PHONE_RATE_LIMIT_TTL)).code(429).send({
          success: false,
          message: MSG_RATE_LIMITED,
          blockExpiresAt: nowUnixSec() + PHONE_RATE_LIMIT_TTL,
        });
      }
      return null;
    };

    if (!codeIn || !/^\d{5}$/.test(codeIn)) {
      const limited = await applyVerifyLimits();
      if (limited) return limited;
      logAuthLine(app, "warn", "AUTH_VERIFY_INVALID", MSG_PIN_INVALID, ip, phone, route);
      return reply.code(400).send({ success: false, message: MSG_PIN_INVALID });
    }

    const expected = await getOtp(phone);
    if (!expected) {
      const limited = await applyVerifyLimits();
      if (limited) return limited;
      logAuthLine(app, "warn", "AUTH_VERIFY_EXPIRED", MSG_PIN_EXPIRED, ip, phone, route);
      return reply.code(410).send({ success: false, message: MSG_PIN_EXPIRED });
    }

    if (expected !== codeIn) {
      const limited = await applyVerifyLimits();
      if (limited) return limited;
      logAuthLine(app, "warn", "AUTH_VERIFY_WRONG_CODE", MSG_PIN_INVALID, ip, phone, route);
      return reply.code(400).send({ success: false, message: MSG_PIN_INVALID });
    }

    const user = await getOrCreateUser(phone);
    await deleteOtp(phone);
    await resetOtpRateLimitsForIpAndPhone(ip, phone);
    logAuthLine(app, "info", "AUTH_VERIFY_SUCCESS", MSG_PIN_CONFIRMED, ip, phone, route);
    return reply.code(200).send({
      success: true,
      message: MSG_PIN_CONFIRMED,
      user,
    });
  });
};
