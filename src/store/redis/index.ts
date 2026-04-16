export { redisClient } from "./client";

export {
  setCallData,
  getCallData,
  getCallIdByEndpointId,
  setEndpointSession,
  getEndpointSession,
  setChannelSession,
  getChannelSession,
  setPendingOriginate,
  getPendingOriginate,
  deletePendingOriginate,
  setActiveIncomingFromPanel,
  getActiveIncomingFromPanel,
  clearActiveIncomingFromPanel,
} from "./calls";

export { setOtp, getOtp, deleteOtp } from "./otp/codes";

export {
  enqueueOtpCall,
  isOtpCallQueued,
  setOtpChannel,
  getOtpChannel,
  deleteOtpChannel,
} from "./otp/queue";

export type { OtpCallJob } from "./otp/queue";

export {
  incrementOtpRequestCounter,
  incrementOtpVerifyCounter,
  incrementOtpRequestCounterByIp,
  incrementOtpRequestCounterByPhone,
  incrementOtpVerifyCounterByIp,
  incrementOtpVerifyCounterByPhone,
  blockOtpRequestByIp,
  blockOtpRequestByPhone,
  blockOtpVerifyByIp,
  blockOtpVerifyByPhone,
  isOtpRequestBlockedByIp,
  isOtpRequestBlockedByPhone,
  isOtpVerifyBlockedByIp,
  isOtpVerifyBlockedByPhone,
  getOtpRequestCounterByIp,
  getOtpRequestCounterByPhone,
  getOtpVerifyCounterByIp,
  getOtpVerifyCounterByPhone,
  resetOtpRequestRateLimitsForIpAndPhone,
  resetOtpVerifyRateLimitsForIpAndPhone,
  resetOtpRateLimitsForIpAndPhone,
} from "./otp/limits";
