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
  blockOtpRequestByIp,
  blockOtpVerifyByIp,
  incrementOtpRequestCounter,
  incrementOtpVerifyCounter,
  incrementOtpRequestCounterByIp,
  incrementOtpRequestCounterByPhone,
  incrementOtpRequestUniquePhoneCounterByIp,
  incrementOtpVerifyCounterByIp,
  incrementOtpVerifyCounterByPhone,
  isOtpRequestBlockedByIp,
  isOtpVerifyBlockedByIp,
  getOtpRequestCounterByIp,
  getOtpRequestCounterByPhone,
  getOtpRequestUniquePhonesByIp,
  getOtpVerifyCounterByIp,
  getOtpVerifyCounterByPhone,
  resetOtpRateLimitsForIpAndPhone,
  resetOtpRequestCounterByPhone,
  resetOtpRequestCounterByPhoneTTL,
  resetOtpRequestRateLimitsForIpAndPhone,
  resetOtpVerifyCounterByPhoneTTL,
  resetOtpVerifyRateLimitsForIpAndPhone,
} from "./otp/limits";
