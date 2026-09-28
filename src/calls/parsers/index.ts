import type { Event } from "#ari";

/**
 * Split PJSIP_DIAL_CONTACTS output into ARI originate endpoints.
 */
export const parseDialContacts = (dialString: string): string[] => {
  return dialString
    .split("&")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
};

/**
 * Статусы «контакт появился».
 *
 * NonQualified — норма: частоту проверки доступности мы не задаём.
 * Removed и Unreachable сюда не входят.
 */
export const CONTACT_APPEARED_STATUSES = new Set(["Created", "NonQualified", "Reachable", "Unknown"]);

/**
 * Адрес записи и статус контакта временной учётки из события.
 *
 * Иначе null: чужая учётка или битое тело события.
 */
export const parseContactStatus = (event: Event): { aor: string; contactStatus: string } | null => {
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
};

/**
 * Адрес записи временной учётки, если в событии контакт только что появился.
 */
export const parseAppearedContactAor = (event: Event): string | null => {
  const contact = parseContactStatus(event);
  if (!contact || !CONTACT_APPEARED_STATUSES.has(contact.contactStatus)) {
    return null;
  }
  return contact.aor;
};

/**
 * Адрес записи временной учётки, если в событии контакт снялся.
 */
export const parseRemovedContactAor = (event: Event): string | null => {
  const contact = parseContactStatus(event);
  if (!contact || contact.contactStatus !== "Removed") {
    return null;
  }
  return contact.aor;
};

/**
 * parsePjsipId — принимает имя канала и возвращает id учётки.
 * Хвост Asterisk после последнего дефиса отбрасывается.
 *
 * @param name имя канала
 * @returns id учётки или null, если имя не разобрано
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

export const parseAriTimestamp = (value: string | undefined): number | null => {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  // Asterisk Date strings use +0000 / -0600; Date.parse needs a colon in the offset.
  const normalized = value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? null : ms;
};
