import { redisClient } from "../client";

/**
 * Store OTP code for phone (canonical 7XXXXXXXXXX); value is a 5-digit string.
 */
export const setOtp = async (phone: string, code: string, ttlSec: number) => {
  const key = `otp:${phone}`;
  await redisClient.set(key, code, "EX", ttlSec);
};

/**
 * Load latest OTP code for phone.
 */
export const getOtp = async (phone: string): Promise<string | null> => {
  const key = `otp:${phone}`;
  return redisClient.get(key);
};

/**
 * Remove OTP code for phone.
 */
export const deleteOtp = async (phone: string) => {
  const key = `otp:${phone}`;
  await redisClient.del(key);
};
