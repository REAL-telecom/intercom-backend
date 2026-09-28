import type { Event } from "#ari";

/**
 * parsePjsipId — принимает имя канала и возвращает id учётной записи.
 * Хвост Asterisk после последнего дефиса отбрасывается.
 *
 * @param name имя канала
 * @returns id учётной записи или `null`, если имя не разобрано
 */
export function parsePjsipId(name: string | undefined): string | null {
  const namePart = name?.split("/")[1];
  if (!namePart) {
    return null;
  }
  const dash = namePart.lastIndexOf("-");
  if (dash <= 0) {
    return null;
  }
  return namePart.slice(0, dash);
}

/**
 * CONTACT_APPEARED_STATUSES — хранит статусы, при которых контакт считается появившимся.
 * `NonQualified` — норма: частоту проверки доступности мы не задаём.
 * `Removed` и `Unreachable` сюда не входят.
 */
const CONTACT_APPEARED_STATUSES = new Set(["Created", "NonQualified", "Reachable", "Unknown"]);

/**
 * parseContactStatus — принимает событие контакта и возвращает адрес записи и статус.
 * Возвращает `null`, если тело события битое.
 * Чужая учётная запись здесь не отсекается: тип проверяет `onContactStatusChange` из `src/calls/events/onContactStatusChange.ts`.
 *
 * @param event событие ARI
 * @returns адрес записи и статус или `null`
 */
function parseContactStatus(event: Event): { aor: string; contactStatus: string } | null {
  const contactInfo = event.contact_info;
  if (!contactInfo || typeof contactInfo !== "object") {
    return null;
  }
  const info = contactInfo as { aor?: unknown; contact_status?: unknown };
  if (typeof info.aor !== "string" || info.aor.length === 0) {
    return null;
  }
  if (typeof info.contact_status !== "string") {
    return null;
  }
  return { aor: info.aor, contactStatus: info.contact_status };
}

/**
 * parseAppearedContactAor — принимает событие и возвращает адрес записи, если контакт только что появился.
 * Иначе возвращает `null`.
 *
 * @param event событие ARI
 * @returns адрес записи или `null`
 */
export function parseAppearedContactAor(event: Event): string | null {
  const contact = parseContactStatus(event);
  if (!contact || !CONTACT_APPEARED_STATUSES.has(contact.contactStatus)) {
    return null;
  }
  return contact.aor;
}

/**
 * parseDialContacts — принимает строку контактов и возвращает список адресов для дозвона.
 * Строка приходит из `PJSIP_DIAL_CONTACTS`.
 *
 * @param dialString строка контактов
 * @returns список адресов
 */
export function parseDialContacts(dialString: string): string[] {
  return dialString
    .split("&")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * parseRemovedContactAor — принимает событие и возвращает адрес записи, если контакт снялся.
 * Иначе возвращает `null`.
 *
 * @param event событие ARI
 * @returns адрес записи или `null`
 */
export function parseRemovedContactAor(event: Event): string | null {
  const contact = parseContactStatus(event);
  if (!contact || contact.contactStatus !== "Removed") {
    return null;
  }
  return contact.aor;
}

/**
 * parseAriTimestamp — принимает метку времени Asterisk и возвращает миллисекунды.
 * Смещение вида `+0000` приводится к виду с двоеточием, иначе разбор даты его не читает.
 *
 * @param value метка времени из события
 * @returns миллисекунды или `null`, если метка пустая или не читается
 */
export function parseAriTimestamp(value: string | undefined): number | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const normalized = value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? null : ms;
}
