import { redisClient } from "../client";

const getRequestCounterByIpKey = (ip: string) => `otp:request:count:ip:${ip}`;
const getRequestCounterByPhoneKey = (phone: string) => `otp:request:count:phone:${phone}`;
const getRequestUniquePhonesByIpKey = (ip: string) => `otp:request:phones:ip:${ip}`;
const getRequestBlockByIpKey = (ip: string) => `otp:request:block:ip:${ip}`;

const getVerifyCounterByIpKey = (ip: string) => `otp:verify:count:ip:${ip}`;
const getVerifyCounterByPhoneKey = (phone: string) => `otp:verify:count:phone:${phone}`;
const getVerifyBlockByIpKey = (ip: string) => `otp:verify:block:ip:${ip}`;

const parseCount = (value: string | null): number => {
  if (!value) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Increment request-code attempts counter by IP with TTL window.
 * Returns updated count.
 */
export const incrementOtpRequestCounterByIp = async (ip: string, ttlSec: number): Promise<number> => {
  const key = getRequestCounterByIpKey(ip);
  const count = await redisClient.incr(key);
  if (count === 1) {
    await redisClient.expire(key, ttlSec);
  }
  return count;
};

/**
 * Increment request-code attempts counter by phone with TTL window.
 * Returns updated count.
 */
export const incrementOtpRequestCounterByPhone = async (
  phone: string,
  ttlSec: number
): Promise<number> => {
  const key = getRequestCounterByPhoneKey(phone);
  const count = await redisClient.incr(key);
  if (count === 1) {
    await redisClient.expire(key, ttlSec);
  }
  return count;
};

/**
 * Count unique request-code phones seen from one IP in TTL window.
 * Returns total unique phone count for this IP window.
 */
export const incrementOtpRequestUniquePhoneCounterByIp = async (
  ip: string,
  phone: string,
  ttlSec: number
): Promise<number> => {
  const key = getRequestUniquePhonesByIpKey(ip);
  const added = await redisClient.sadd(key, phone);
  if (added === 1) {
    const ttl = await redisClient.ttl(key);
    if (ttl < 0) {
      await redisClient.expire(key, ttlSec);
    }
  }
  return redisClient.scard(key);
};

/**
 * Read unique request-code phones seen from one IP in current TTL window.
 */
export const getOtpRequestUniquePhonesByIp = async (ip: string): Promise<string[]> => {
  return redisClient.smembers(getRequestUniquePhonesByIpKey(ip));
};

/**
 * Remove request-code counter by phone.
 */
export const resetOtpRequestCounterByPhone = async (phone: string): Promise<void> => {
  await redisClient.del(getRequestCounterByPhoneKey(phone));
};

/**
 * Reset TTL on the phone request-code counter (e.g. on first soft limit) to keep the abuse window anchored.
 */
export const refreshOtpRequestCounterByPhoneTTL = async (phone: string, ttlSec: number): Promise<void> => {
  await redisClient.expire(getRequestCounterByPhoneKey(phone), ttlSec);
};

/**
 * Increment verify-code attempts counter by IP with TTL window.
 * Returns updated count.
 */
export const incrementOtpVerifyCounterByIp = async (ip: string, ttlSec: number): Promise<number> => {
  const key = getVerifyCounterByIpKey(ip);
  const count = await redisClient.incr(key);
  if (count === 1) {
    await redisClient.expire(key, ttlSec);
  }
  return count;
};

/**
 * Increment verify-code attempts counter by phone with TTL window.
 * Returns updated count.
 */
export const incrementOtpVerifyCounterByPhone = async (
  phone: string,
  ttlSec: number
): Promise<number> => {
  const key = getVerifyCounterByPhoneKey(phone);
  const count = await redisClient.incr(key);
  if (count === 1) {
    await redisClient.expire(key, ttlSec);
  }
  return count;
};

/**
 * Set temporary request-code block by IP.
 */
export const blockOtpRequestByIp = async (ip: string, ttlSec: number) => {
  await redisClient.set(getRequestBlockByIpKey(ip), "1", "EX", ttlSec);
};

/**
 * Set temporary verify-code block by IP.
 */
export const blockOtpVerifyByIp = async (ip: string, ttlSec: number) => {
  await redisClient.set(getVerifyBlockByIpKey(ip), "1", "EX", ttlSec);
};

/**
 * Check whether request-code is blocked by IP.
 */
export const isOtpRequestBlockedByIp = async (ip: string): Promise<boolean> => {
  const value = await redisClient.get(getRequestBlockByIpKey(ip));
  return value === "1";
};

/**
 * Check whether verify-code is blocked by IP.
 */
export const isOtpVerifyBlockedByIp = async (ip: string): Promise<boolean> => {
  const value = await redisClient.get(getVerifyBlockByIpKey(ip));
  return value === "1";
};

/**
 * Read current request-code counter by IP.
 */
export const getOtpRequestCounterByIp = async (ip: string): Promise<number> => {
  const value = await redisClient.get(getRequestCounterByIpKey(ip));
  return parseCount(value);
};

/**
 * Read current request-code counter by phone.
 */
export const getOtpRequestCounterByPhone = async (phone: string): Promise<number> => {
  const value = await redisClient.get(getRequestCounterByPhoneKey(phone));
  return parseCount(value);
};

/**
 * Read current verify-code counter by IP.
 */
export const getOtpVerifyCounterByIp = async (ip: string): Promise<number> => {
  const value = await redisClient.get(getVerifyCounterByIpKey(ip));
  return parseCount(value);
};

/**
 * Read current verify-code counter by phone.
 */
export const getOtpVerifyCounterByPhone = async (phone: string): Promise<number> => {
  const value = await redisClient.get(getVerifyCounterByPhoneKey(phone));
  return parseCount(value);
};

/**
 * Clear request-code counters and blocks for given IP + phone.
 */
export const resetOtpRequestRateLimitsForIpAndPhone = async (ip: string, phone: string) => {
  await redisClient.del(
    getRequestCounterByIpKey(ip),
    getRequestUniquePhonesByIpKey(ip),
    getRequestCounterByPhoneKey(phone),
    getRequestBlockByIpKey(ip),
  );
};

/**
 * Clear verify-code counters and blocks for given IP + phone.
 */
export const resetOtpVerifyRateLimitsForIpAndPhone = async (ip: string, phone: string) => {
  await redisClient.del(
    getVerifyCounterByIpKey(ip),
    getVerifyCounterByPhoneKey(phone),
    getVerifyBlockByIpKey(ip),
  );
};

/**
 * Clear request-code and verify-code rate limits for given IP + phone.
 */
export const resetOtpRateLimitsForIpAndPhone = async (ip: string, phone: string) => {
  await Promise.all([
    resetOtpRequestRateLimitsForIpAndPhone(ip, phone),
    resetOtpVerifyRateLimitsForIpAndPhone(ip, phone),
  ]);
};

/**
 * Backward-compatible alias.
 */
export const incrementOtpRequestCounter = incrementOtpRequestCounterByIp;

/**
 * Backward-compatible alias.
 */
export const incrementOtpVerifyCounter = incrementOtpVerifyCounterByIp;
