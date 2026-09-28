/**
 * Глоссарий.
 *
 * Эндпоинт — объект ARI `endpoint`. Описывает SIP-устройство, которое вызывают по имени.
 */

import { env } from "#config";
import { AriRequestError, formatRequestError, request } from "./request";

/**
 * Endpoint — представляет параметры учётной записи телефона на время одного звонка.
 * После звонка учётная запись телефона удаляется.
 *
 * @property context — контекст диалплана
 * @property id — идентификатор учётной записи телефона
 * @property maxContacts — предел одновременных контактов
 * @property password — пароль учётной записи телефона
 * @property username — имя учётной записи телефона
 */
type Endpoint = {
  context: string;
  id: string;
  maxContacts?: number;
  password: string;
  username: string;
};

/**
 * getEndpointSubscriptionPath — возвращает путь подписки на события эндпоинта.
 *
 * @param endpointId идентификатор учётной записи телефона
 * @returns путь подписки
 */
function getEndpointSubscriptionPath(endpointId: string) {
  const params = new URLSearchParams({
    eventSource: `endpoint:PJSIP/${endpointId}`,
  });
  return `/applications/${encodeURIComponent(env.ariAppName)}/subscription?${params.toString()}`;
}

/**
 * subscribeToEndpoint — подписывает приложение на события эндпоинта.
 * Поток событий открыт без `subscribeAll`. Без явной подписки сообщения о контакте не доходят.
 * Включать `subscribeAll` на живом приложении нельзя.
 *
 * @param endpointId идентификатор учётной записи телефона
 * @throws `Error`, если подписка не создалась
 */
async function subscribeToEndpoint(endpointId: string) {
  try {
    await request(getEndpointSubscriptionPath(endpointId), "POST");
  } catch (error) {
    throw new Error(`ARI subscribe endpoint ${endpointId} failed: ${formatRequestError(error)}`);
  }
}

/**
 * unsubscribeFromEndpoint — снимает подписку на события эндпоинта.
 * Отсутствие подписки ошибкой не считается.
 *
 * @param endpointId идентификатор учётной записи телефона
 * @throws `Error`, если снять подписку не удалось, а подписка при этом существовала
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
 * createEndpoint — создаёт учётную запись телефона в PJSIP.
 * Повторная запись с тем же идентификатором обновляет существующие объекты.
 * Порядок объектов совпадает с `deleteEndpoint`.
 * После записи подписывает приложение на события этого endpoint.
 *
 * @param params параметры учётной записи телефона
 * @throws `Error`, если запись объекта или подписка не прошла
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

  // Сначала AOR, затем auth, затем эндпоинт — те же объекты, что удаляет deleteEndpoint.
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
 * deleteEndpoint — удаляет учётную запись телефона в PJSIP.
 * Сначала снимает подписку. Отсутствие подписки или объекта ошибкой не считается.
 *
 * @param endpointId идентификатор учётной записи телефона
 * @throws `Error`, если удаление не удалось, а объект при этом существовал
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
