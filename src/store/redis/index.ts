export { redisClient } from "./client";

export {
  setCall,
  getCall,
  setDialStatus,
  getDialStatus,
  addDialedChannel,
  listDialedChannels,
  addDialedContact,
  removeDialedContact,
  setEndpoint,
  getEndpoint,
  releaseEndpoint,
  setChannel,
  getChannel,
  setOriginate,
  getOriginate,
  deleteOriginate,
  clearCall,
  markBridgeForCleanup,
  markCallOverPushSet,
} from "./calls";

export type { Call } from "./calls";

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
