import type { Event } from "../ari";

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
export const readContactStatus = (event: Event): { aor: string; contactStatus: string } | null => {
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
export const readAppearedContactAor = (event: Event): string | null => {
  const contact = readContactStatus(event);
  if (!contact || !CONTACT_APPEARED_STATUSES.has(contact.contactStatus)) {
    return null;
  }
  return contact.aor;
};

/**
 * Адрес записи временной учётки, если в событии контакт снялся.
 */
export const readRemovedContactAor = (event: Event): string | null => {
  const contact = readContactStatus(event);
  if (!contact || contact.contactStatus !== "Removed") {
    return null;
  }
  return contact.aor;
};
