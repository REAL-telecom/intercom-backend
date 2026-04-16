import { redisClient } from "../client";

const getRequestCounterByIpKey = (ip: string) => `otp:request:count:ip:${ip}`;
const getRequestCounterByPhoneKey = (phone: string) => `otp:request:count:phone:${phone}`;
const getRequestBlockByIpKey = (ip: string) => `otp:request:block:ip:${ip}`;
const getRequestBlockByPhoneKey = (phone: string) => `otp:request:block:phone:${phone}`;

const getVerifyCounterByIpKey = (ip: string) => `otp:verify:count:ip:${ip}`;
const getVerifyCounterByPhoneKey = (phone: string) => `otp:verify:count:phone:${phone}`;
const getVerifyBlockByIpKey = (ip: string) => `otp:verify:block:ip:${ip}`;
const getVerifyBlockByPhoneKey = (phone: string) => `otp:verify:block:phone:${phone}`;

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
 * Set temporary request-code block by phone.
 */
export const blockOtpRequestByPhone = async (phone: string, ttlSec: number) => {
  await redisClient.set(getRequestBlockByPhoneKey(phone), "1", "EX", ttlSec);
};

/**
 * Set temporary verify-code block by IP.
 */
export const blockOtpVerifyByIp = async (ip: string, ttlSec: number) => {
  await redisClient.set(getVerifyBlockByIpKey(ip), "1", "EX", ttlSec);
};

/**
 * Set temporary verify-code block by phone.
 */
export const blockOtpVerifyByPhone = async (phone: string, ttlSec: number) => {
  await redisClient.set(getVerifyBlockByPhoneKey(phone), "1", "EX", ttlSec);
};

/**
 * Check whether request-code is blocked by IP.
 */
export const isOtpRequestBlockedByIp = async (ip: string): Promise<boolean> => {
  const value = await redisClient.get(getRequestBlockByIpKey(ip));
  return value === "1";
};

/**
 * Check whether request-code is blocked by phone.
 */
export const isOtpRequestBlockedByPhone = async (phone: string): Promise<boolean> => {
  const value = await redisClient.get(getRequestBlockByPhoneKey(phone));
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
 * Check whether verify-code is blocked by phone.
 */
export const isOtpVerifyBlockedByPhone = async (phone: string): Promise<boolean> => {
  const value = await redisClient.get(getVerifyBlockByPhoneKey(phone));
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
    getRequestCounterByPhoneKey(phone),
    getRequestBlockByIpKey(ip),
    getRequestBlockByPhoneKey(phone)
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
    getVerifyBlockByPhoneKey(phone)
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
