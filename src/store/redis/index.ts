export { redisClient } from "./client";

export {
  setCallData,
  getCallData,
  claimCallOutcome,
  getCallOutcome,
  addOriginateChannelId,
  getOriginateChannelIds,
  claimContactForDial,
  releaseContactForDial,
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

export type { CallOutcome } from "./calls";

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
  resetOtpRateLimitsByIp,
  resetOtpRateLimitsByPhone,
  resetOtpRequestCounterByPhone,
  resetOtpRequestCounterByPhoneTTL,
  resetOtpVerifyCounterByPhoneTTL,
} from "./otp/limits";
