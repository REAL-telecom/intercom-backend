/**
 * Глоссарий.
 *
 * fail2ban — система блокировки IP после неудачных попыток. Читает journald
 *   построчно и по шаблону извлекает ip=... для бана.
 * Jail — группа правил fail2ban. Наш jail — auth, для маршрутов аутентификации.
 * SQLite — встроенная база данных. fail2ban складывает свои баны в неё,
 *   своего HTTP-API у fail2ban нет.
 * Формат строки — плоский, без JSON: fail2ban ищет поля в тексте,
 *   не в структурированных полях pino.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FastifyInstance } from "fastify";

// execFile запускает внешний процесс и отдаёт результат в колбэк.
// promisify превращает колбэк в промис, чтобы читать базу fail2ban через await.
const execFileAsync = promisify(execFile);

// Путь к базе fail2ban. Читаем напрямую SQLite-файл: своего API у fail2ban нет.
const FAIL2BAN_DB_PATH = "/var/lib/fail2ban/fail2ban.sqlite3";
// Наш jail в fail2ban. Имя должно совпадать с конфигом fail2ban на сервере.
const FAIL2BAN_BACKEND_JAIL = "auth";

/**
 * Уровни лога, которые используют строки для fail2ban.
 * error не используется: сбой одной операции не значит, что воркер сломан.
 */
type LogLevel = "info" | "warn";

/**
 * Экранирует строку для подстановки в SQL-литерал.
 * Заменяет одиночную кавычку на две: 'It''s'. Защита от инъекции в
 * запросы к SQLite fail2ban, куда подставляются ip и jail.
 *
 * @param value — произвольная строка
 * @returns строка в одинарных кавычках с экранированием
 */
function toSqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Пишет одну строку в лог в формате, который понимает fail2ban.
 *
 * Формат: `[ТЕГ] сообщение ip=... phone=... route=...`.
 * Строка одной строкой без переносов — fail2ban читает построчно.
 *
 * @param app — приложение Fastify
 * @param level — уровень лога
 * @param tag — тег события, например AUTH_QUEUE_DROP_BANNED_IP
 * @param message — текст сообщения
 * @param ip — IP-адрес клиента
 * @param phone — телефон в канонической форме
 * @param route — маршрут, откуда пришёл запрос
 */
export function logFail2banLine(
  app: FastifyInstance,
  level: LogLevel,
  tag: string,
  message: string,
  ip: string,
  phone: string,
  route: string
) {
  const line = `[${tag}] ${message} ip=${ip} phone=${phone} route=${route}`;
  app.log[level](line);
}

/**
 * Проверяет по базе fail2ban, забанен ли IP.
 *
 * Запрос идёт напрямую в SQLite-файл fail2ban: своего HTTP-API у него нет.
 * В таблице bans ищется запись с нашим jail и активным сроком бана.
 *
 * @param ip — IP-адрес клиента
 * @param app — приложение Fastify
 * @returns true, если IP в активном бане. При ошибке чтения базы — false,
 *   чтобы воркер продолжал работать.
 */
export async function isClientBanned(ip: string, app: FastifyInstance): Promise<boolean> {
  const jail = toSqlLiteral(FAIL2BAN_BACKEND_JAIL);
  const ipLiteral = toSqlLiteral(ip);

  // Проверка: есть ли запись в bans, где срок бана не истёк или бан бессрочный.
  // bantime = -1 у fail2ban означает «навсегда».
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
    app.log.warn({ err }, "fail2ban sqlite check failed");
    return false;
  }
}
