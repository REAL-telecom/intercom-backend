/**
 * Глоссарий.
 *
 * OTP (one-time password) — одноразовый код подтверждения. Пятизначный,
 *   живёт в Redis TTL, звонит по нему робот.
 * Trunk — транк SIP-оператора. Звонок уходит на номер через оператора.
 *   У нас один транк — multifon.
 * Trunk PJSIP — строка вида PJSIP/<номер>@<транк>, куда ARI отправляет INVITE.
 */

import { FastifyInstance } from "fastify";
import { createChannelInDialplan } from "../ari";
import { isClientBanned, logFail2banLine } from "../fail2ban";
import { deleteOtp, getOtp } from "../store/redis/otp/codes";
import {
  deleteOtpChannel,
  getOtpChannel,
  setOtpChannel,
  waitOtpCall,
} from "../store/redis/otp/queue";

// Контекст диалплана, куда Asterisk отправляет звонок с OTP-кодом.
const OTP_CONTEXT = "otp-out";
// Имя транка оператора в PJSIP. Должно совпадать со строкой в конфиге Asterisk.
const OTP_TRUNK = "multifon";
// Сколько держать в Redis связку «ARI-канал OTP → задача очереди».
// TTL с запасом: звонок длится секунды, но если ARI-канал не снимется сразу,
// запись должна ещё полежать, чтобы ChannelDestroyed её нашёл.
const OTP_OUT_CHANNEL_MAP_TTL_SEC = 3600;
// Предел ожидания задачи из Redis на одну итерацию цикла. Короткий, чтобы
// цикл не висел на одном BLPOP и реагировал на остановку процесса.
const OTP_WAIT_TIMEOUT_SEC = 1;
// Имя маршрута в логе: по нему fail2ban ловит строки и банит IP.
const OTP_WORKER_ROUTE = "otp-worker";

// Сообщения в лог. Используются и в ответе клиенту, и как тела логов.
const MSG_CALL_FAILED = "Не удалось совершить звонок.";
const MSG_QUEUE_DROP_BANNED = "Задача звонка отклонена: IP заблокирован.";
const MSG_QUEUE_DROP_EXPIRED = "Задача звонка отклонена: код отсутствует.";

/**
 * Разбивает пятизначный код на переменные для диалплана.
 * Asterisk в диалплане прочитает их как ${OTP_D1}…${OTP_D5} и озвучит
 * каждую цифру отдельно. Разбивка нужна, чтобы код читался как «один-два-три»
 * на паузах, а не как число.
 *
 * @param code — пятизначный код
 * @returns объект из пяти переменных OTP_D1…OTP_D5
 */
function toDialplanDigits(code: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (let i = 0; i < 5; i++) {
    vars[`OTP_D${i + 1}`] = code[i] ?? "";
  }
  return vars;
}

/**
 * Обрабатывает одну задачу из очереди OTP-звонков.
 *
 * Шаги:
 *  1. Читает задачу из Redis с коротким ожиданием.
 *  2. Проверяет, не забанен ли IP клиента в fail2ban.
 *  3. Достаёт код из Redis; если код истёк — задача отбрасывается.
 *  4. Отправляет исходящий звонок на телефон через оператора.
 *  5. Кладёт связку канал-задача в Redis, чтобы при падении канала
 *     можно было снять запись.
 *
 * @param app — приложение Fastify
 */
async function handleOtpCall(app: FastifyInstance) {
  const job = await waitOtpCall(OTP_WAIT_TIMEOUT_SEC);
  if (!job) return;

  const { phone, ip } = job;

  // Забаненный IP не звонит: до выхода из очереди задача отбрасывается молча.
  if (await isClientBanned(ip, app)) {
    logFail2banLine(app, "warn", "AUTH_QUEUE_DROP_BANNED_IP", MSG_QUEUE_DROP_BANNED, ip, phone, OTP_WORKER_ROUTE);
    return;
  }

  // Код мог истечь в Redis, пока задача ждала в очереди. Тогда звонка не будет.
  const code = await getOtp(phone);
  if (!code) {
    logFail2banLine(app, "warn", "AUTH_QUEUE_DROP_NO_OTP", MSG_QUEUE_DROP_EXPIRED, ip, phone, OTP_WORKER_ROUTE);
    return;
  }

  try {
    // Оригинация в диалплан, не в Stasis: для OTP-звонка ARI не нужен,
    // достаточно проиграть голосом код и повесить трубку.
    const channel = (await createChannelInDialplan({
      endpoint: `PJSIP/${phone}@${OTP_TRUNK}`,
      context: OTP_CONTEXT,
      extension: "s",
      priority: 1,
      variables: toDialplanDigits(code),
    })) as { id?: string } | undefined;

    // Запоминаем, что этот ARI-канал обслуживает именно эту задачу.
    // Нужно, чтобы при ChannelDestroyed снять запись.
    if (channel?.id) {
      await setOtpChannel(channel.id, job, OTP_OUT_CHANNEL_MAP_TTL_SEC);
    }
  } catch (err) {
    // Оригинация упала: код в Redis уже бесполезен, стираем.
    await deleteOtp(phone);
    logFail2banLine(app, "warn", "AUTH_REQ_CALL_FAILED", MSG_CALL_FAILED, ip, phone, OTP_WORKER_ROUTE);
    app.log.warn({ err }, "otp dialer originate failed");
  }
}

/**
 * Запускает бесконечный цикл чтения OTP-очереди.
 *
 * Цикл не завершается: читает задачу из Redis с коротким ожиданием,
 * обрабатывает её, повторяет. Каждая итерация изолирует свои ошибки,
 * чтобы одна неудачная задача не остановила обзвонщик.
 *
 * @param app — приложение Fastify
 */
export async function startOtpDialer(app: FastifyInstance) {
  app.log.info("OTP dialer started");
  // for (;;): обзвонщик живёт, пока жив процесс. Выход из цикла не предусмотрен.
  for (;;) {
    try {
      await handleOtpCall(app);
    } catch (err) {
      app.log.warn({ err }, "otp dialer loop iteration failed");
    }
  }
}

/**
 * Убирает связку «канал-задача» после уничтожения OTP-канала.
 *
 * Приходит событие ChannelDestroyed. Если канал принадлежал OTP-звонку,
 * удаляем запись в Redis и возвращаем true — вызывающий код поймёт,
 * что событие обработано и дальше его разбирать не надо.
 *
 * @param app — приложение Fastify
 * @param channelId — идентификатор ARI-канала
 * @returns true, если канал был OTP-звонком. false — чужая задача.
 */
export async function cleanupOtpChannel(app: FastifyInstance, channelId: string) {
  const job = await getOtpChannel(channelId);
  if (!job) return false;

  await deleteOtpChannel(channelId);
  app.log.info({ channelId, phone: job.phone, ip: job.ip }, "OTP channel destroyed: cleaned channel mapping");
  return true;
}
