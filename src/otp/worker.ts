import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FastifyInstance } from "fastify";
import { originateToDialplan } from "../ari/client";
import { deleteOtp, getOtp } from "../store/redis/otp/codes";
import {
  deleteOtpChannel,
  getOtpChannel,
  setOtpChannel,
  waitOtpCall,
} from "../store/redis/otp/queue";

const execFileAsync = promisify(execFile);

const OTP_CONTEXT = "otp-out";
const OTP_TRUNK = "multifon";
const OTP_OUT_CHANNEL_MAP_TTL_SEC = 3600;
const OTP_WAIT_TIMEOUT_SEC = 1;

const FAIL2BAN_DB_PATH = "/var/lib/fail2ban/fail2ban.sqlite3";
const FAIL2BAN_BACKEND_JAIL = "auth-combined";
const OTP_WORKER_ROUTE = "otp-worker";

const MSG_CALL_FAILED = "Не удалось совершить звонок.";
const MSG_QUEUE_DROP_BANNED = "Задача звонка отклонена: IP заблокирован.";
const MSG_QUEUE_DROP_EXPIRED = "Задача звонка отклонена: код отсутствует.";

type LogLevel = "info" | "warn";

const toSqlLiteral = (value: string): string => {
  return `'${value.replace(/'/g, "''")}'`;
};

const logOtpLine = (
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

const isClientIpBanned = async (ip: string, app: FastifyInstance): Promise<boolean> => {
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
    app.log.warn({ err }, "otp worker fail2ban sqlite check failed");
    return false;
  }
};

const otpVariables = (code: string): Record<string, string> => {
  const vars: Record<string, string> = {};
  for (let i = 0; i < 5; i++) {
    vars[`OTP_D${i + 1}`] = code[i] ?? "";
  }
  return vars;
};

const handleOtpCall = async (app: FastifyInstance) => {
  const job = await waitOtpCall(OTP_WAIT_TIMEOUT_SEC);
  if (!job) return;

  const { phone, ip } = job;

  if (await isClientIpBanned(ip, app)) {
    logOtpLine(app, "warn", "AUTH_QUEUE_DROP_BANNED_IP", MSG_QUEUE_DROP_BANNED, ip, phone, OTP_WORKER_ROUTE);
    return;
  }

  const code = await getOtp(phone);
  if (!code) {
    logOtpLine(app, "warn", "AUTH_QUEUE_DROP_NO_OTP", MSG_QUEUE_DROP_EXPIRED, ip, phone, OTP_WORKER_ROUTE);
    return;
  }

  try {
    const channel = (await originateToDialplan({
      endpoint: `PJSIP/${phone}@${OTP_TRUNK}`,
      context: OTP_CONTEXT,
      extension: "s",
      priority: 1,
      variables: otpVariables(code),
    })) as { id?: string } | undefined;

    if (channel?.id) {
      await setOtpChannel(channel.id, job, OTP_OUT_CHANNEL_MAP_TTL_SEC);
    }
  } catch (err) {
    await deleteOtp(phone);
    logOtpLine(app, "warn", "AUTH_REQ_CALL_FAILED", MSG_CALL_FAILED, ip, phone, OTP_WORKER_ROUTE);
    app.log.warn({ err }, "otp worker originate failed");
  }
};

/**
 * Start persistent OTP queue consumer loop.
 * Runs indefinitely; each iteration isolates its own errors.
 */
export const startOtpWorker = async (app: FastifyInstance) => {
  app.log.info("OTP worker started");
  while (true) {
    try {
      await handleOtpCall(app);
    } catch (err) {
      app.log.warn({ err }, "otp worker loop iteration failed");
    }
  }
};

/**
 * Cleanup OTP channel mapping on ChannelDestroyed event.
 * Returns true when channel belonged to OTP flow and was handled.
 */
export const handleOtpChannelDestroyed = async (app: FastifyInstance, channelId: string) => {
  const job = await getOtpChannel(channelId);
  if (!job) return false;

  await deleteOtpChannel(channelId);
  app.log.info({ channelId, phone: job.phone, ip: job.ip }, "OTP channel destroyed: cleaned channel mapping");
  return true;
};
