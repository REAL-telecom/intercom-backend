/**
 * Глоссарий.
 *
 * fail2ban — система блокировки IP после неудачных попыток. Читает journald построчно и по шаблону извлекает `ip=` для бана.
 * Jail — группа правил fail2ban. Наш jail — `auth`, для маршрутов аутентификации.
 * SQLite — встроенная база. fail2ban складывает баны в неё. Своего HTTP-API у fail2ban нет.
 * Формат строки — плоский, без JSON. fail2ban ищет поля в тексте, не в структурированных полях pino.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FastifyInstance } from "fastify";

/**
 * execFileAsync — возвращает запуск внешней команды как промис.
 * `execFile` отдаёт результат в колбэк. Промис нужен, чтобы читать базу fail2ban через await.
 */
const execFileAsync = promisify(execFile);

/**
 * FAIL2BAN_DB_PATH — задаёт путь к базе fail2ban.
 * Читаем файл SQLite напрямую: своего API у fail2ban нет.
 */
const FAIL2BAN_DB_PATH = "/var/lib/fail2ban/fail2ban.sqlite3";

/**
 * FAIL2BAN_BACKEND_JAIL — задаёт имя jail в fail2ban.
 * Имя должно совпадать с конфигом fail2ban на сервере.
 */
const FAIL2BAN_BACKEND_JAIL = "auth";

/**
 * LogLevel — представляет уровень строки для fail2ban.
 * `error` сюда не входит: сбой одной операции не значит, что воркер сломан.
 */
type LogLevel = "info" | "warn";

/**
 * toSqlLiteral — преобразует строку в SQL-литерал.
 * Одиночная кавычка удваивается, например `It''s`. Так `ip` и jail не становятся частью запроса к SQLite fail2ban.
 *
 * @param value произвольная строка
 * @returns строка в одинарных кавычках
 */
function toSqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * logFail2banLine — пишет одну строку в лог в формате, который понимает fail2ban.
 * Формат: `[тег] сообщение ip=... phone=... route=...`.
 * Строка без переносов: fail2ban читает журнал построчно.
 *
 * @param app приложение
 * @param level уровень лога
 * @param tag тег события, например `AUTH_QUEUE_DROP_BANNED_IP`
 * @param message текст сообщения
 * @param ip IP-адрес клиента
 * @param phone телефон в канонической форме
 * @param route маршрут, с которого пришёл запрос
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
 * isClientBanned — возвращает признак активного бана IP в базе fail2ban.
 * Запрос идёт напрямую в файл SQLite: своего HTTP-API у fail2ban нет.
 * В таблице `bans` ищется запись с нашим jail и не истёкшим сроком.
 * Если базу прочитать не удалось, возвращает ложь, чтобы воркер продолжал работать.
 *
 * @param ip IP-адрес клиента
 * @param app приложение
 * @returns признак активного бана
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
