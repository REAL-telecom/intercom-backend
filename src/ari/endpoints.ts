/**
 * Глоссарий.
 *
 * endpoint — объект ARI: описывает конечное SIP-устройство, вызываемое по имени.
 */

import { env } from "../config";
import { AriRequestError, formatRequestError, request } from "./request";

/**
 * Параметры временного endpoint, создаваемого на время одного звонка.
 * Используется для временных tmp_* учёток.
 * Удаляется после звонка.
 */
type Endpoint = {
  context: string;
  id: string;
  maxContacts?: number;
  password: string;
  username: string;
};

/**
 * Возвращает путь для подписки на события указанного endpoint.
 *
 * @param endpointId — id временного endpoint
 * @returns путь с query-параметром `eventSource`
 */
function getEndpointSubscriptionPath(endpointId: string) {
  const params = new URLSearchParams({
    eventSource: `endpoint:PJSIP/${endpointId}`,
  });
  return `/applications/${encodeURIComponent(env.ariAppName)}/subscription?${params.toString()}`;
}

/**
 * Подписывает приложение на события endpoint.
 *
 * Сокет открыт без subscribeAll. Без явной подписки сообщения о контакте
 * до нас не дойдут. subscribeAll на живом приложении включать нельзя.
 *
 * @param endpointId — id временного endpoint
 * @throws Error, если подписка не создалась
 */
async function subscribeToEndpoint(endpointId: string) {
  try {
    await request(getEndpointSubscriptionPath(endpointId), "POST");
  } catch (error) {
    throw new Error(`ARI subscribe endpoint ${endpointId} failed: ${formatRequestError(error)}`);
  }
}

/**
 * Отписывается от событий endpoint.
 *
 * Отсутствие подписки игнорируется.
 *
 * @param endpointId — id временного endpoint
 * @throws Error, если снять подписку не удалось по причине кроме 404
 */
async function unsubscribeFromEndpoint(endpointId: string) {
  try {
    await request(getEndpointSubscriptionPath(endpointId), "DELETE");
  } catch (error) {
    // Подписки уже нет: цель достигнута.
    if (error instanceof AriRequestError && error.status === 404) {
      return;
    }
    throw new Error(`ARI unsubscribe endpoint ${endpointId} failed: ${formatRequestError(error)}`);
  }
}

/**
 * Создаёт временный PJSIP endpoint через ARI.
 *
 * Повторный PUT с тем же id обновляет существующие объекты.
 * После записи подписывает приложение на события этого endpoint.
 *
 * @param params — параметры временной учётки
 * @throws Error с деталями, если один из PUT-ов или подписка не прошли
 */
export async function createEndpoint(params: Endpoint) {
  const expiration = String(env.tempAorExpirationSec);
  const objects: {
    fields: { attribute: string; value: string }[];
    objectType: "aor" | "auth" | "endpoint";
  }[] = [
    {
      fields: [
        { attribute: "max_contacts", value: String(params.maxContacts ?? 1) },
        { attribute: "default_expiration", value: expiration },
        { attribute: "maximum_expiration", value: expiration },
      ],
      objectType: "aor",
    },
    {
      fields: [
        { attribute: "auth_type", value: "userpass" },
        { attribute: "username", value: params.username },
        { attribute: "password", value: params.password },
      ],
      objectType: "auth",
    },
    {
      fields: [
        { attribute: "transport", value: "transport-udp" },
        { attribute: "aors", value: params.id },
        { attribute: "auth", value: params.id },
        { attribute: "context", value: params.context },
        { attribute: "disallow", value: "all" },
        { attribute: "allow", value: "ulaw,alaw,h264" },
        { attribute: "direct_media", value: "no" },
        { attribute: "force_rport", value: "yes" },
        { attribute: "rewrite_contact", value: "yes" },
        { attribute: "rtp_symmetric", value: "yes" },
        { attribute: "ice_support", value: "yes" },
      ],
      objectType: "endpoint",
    },
  ];

  // Сначала AOR, затем auth, затем endpoint — те же объекты, что удаляет deleteEndpoint.
  for (const { fields, objectType } of objects) {
    const path = `/asterisk/config/dynamic/res_pjsip/${objectType}/${encodeURIComponent(params.id)}`;
    try {
      await request(path, "PUT", { fields });
    } catch (error) {
      throw new Error(`ARI create ${objectType} ${params.id} failed: ${formatRequestError(error)}`);
    }
  }
  await subscribeToEndpoint(params.id);
}

/**
 * Удаляет PJSIP endpoint: снимает подписку и удаляет aor, auth, endpoint.
 * Отсутствие подписки и endpoint игнорируется.
 *
 * @param endpointId — id временного endpoint
 * @throws Error с деталями, если удаление не прошло по причине кроме 404
 */
export async function deleteEndpoint(endpointId: string) {
  await unsubscribeFromEndpoint(endpointId);
  // AOR идёт первым: Asterisk снимает зарегистрированные контакты при удалении AOR.
  // Объект endpoint идёт последним: пока его запись существует, задача очистки находит объект и повторяет попытку.
  const objectTypes = ["aor", "auth", "endpoint"] as const;
  for (const objectType of objectTypes) {
    const path = `/asterisk/config/dynamic/res_pjsip/${objectType}/${encodeURIComponent(endpointId)}`;
    try {
      await request(path, "DELETE");
    } catch (error) {
      // Объекта уже нет: цель достигнута.
      if (error instanceof AriRequestError && error.status === 404) {
        continue;
      }
      throw new Error(`ARI delete ${objectType} ${endpointId} failed: ${formatRequestError(error)}`);
    }
  }
}
