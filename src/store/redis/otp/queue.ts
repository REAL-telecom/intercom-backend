import { redisBlockingClient, redisClient } from "../client";

export type OtpCallJob = {
  phone: string;
  ip: string;
};

const OTP_QUEUE_KEY = "otp:queue";
const OTP_QUEUE_PHONES_SET_KEY = "otp:queue:phones";
const OTP_CHANNEL_TO_JOB_PREFIX = "otp:channel-job:";

/**
 * Enqueue an outgoing OTP call job if this phone is not already queued.
 * Queue policy is fixed: producer uses RPUSH, worker consumes with LPOP (FIFO).
 */
export const enqueueOtpCall = async (job: OtpCallJob): Promise<boolean> => {
  const isNewPhone = await redisClient.sadd(OTP_QUEUE_PHONES_SET_KEY, job.phone);
  if (isNewPhone === 0) {
    return false;
  }

  await redisClient.rpush(OTP_QUEUE_KEY, JSON.stringify(job));
  return true;
};

/**
 * Whether an OTP call job for this phone is already in the queue.
 */
export const isOtpCallQueued = async (phone: string): Promise<boolean> => {
  const result = await redisClient.sismember(OTP_QUEUE_PHONES_SET_KEY, phone);
  return result === 1;
};

/**
 * Block until a job appears at queue head (BLPOP) or timeout expires.
 * Returns null on timeout.
 */
export const waitOtpCall = async (timeoutSec: number): Promise<OtpCallJob | null> => {
  const response = await redisBlockingClient.blpop(OTP_QUEUE_KEY, timeoutSec);
  if (!response || response.length < 2) return null;

  const value = response[1];
  const parsed = JSON.parse(value) as Partial<OtpCallJob>;
  if (!parsed.phone || !parsed.ip) return null;

  const job = { phone: parsed.phone, ip: parsed.ip };
  await redisClient.srem(OTP_QUEUE_PHONES_SET_KEY, job.phone);
  return job;
};

/**
 * Map ARI channel id to the active OTP call job (for ChannelDestroyed cleanup).
 */
export const setOtpChannel = async (channelId: string, job: OtpCallJob, ttlSec: number) => {
  const key = `${OTP_CHANNEL_TO_JOB_PREFIX}${channelId}`;
  await redisClient.set(key, JSON.stringify(job), "EX", ttlSec);
};

/**
 * Load OTP call job by ARI channel id.
 */
export const getOtpChannel = async (channelId: string): Promise<OtpCallJob | null> => {
  const key = `${OTP_CHANNEL_TO_JOB_PREFIX}${channelId}`;
  const value = await redisClient.get(key);
  if (!value) return null;

  const parsed = JSON.parse(value) as Partial<OtpCallJob>;
  if (!parsed.phone || !parsed.ip) return null;
  return { phone: parsed.phone, ip: parsed.ip };
};

/**
 * Remove OTP call job mapping for ARI channel id.
 */
export const deleteOtpChannel = async (channelId: string) => {
  const key = `${OTP_CHANNEL_TO_JOB_PREFIX}${channelId}`;
  await redisClient.del(key);
};
