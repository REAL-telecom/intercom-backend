/**
 * PushPlatform — представляет платформу push-токена.
 *
 * Значения:
 *  - `android` — FCM
 *  - `ios_voip` — PushKit, пуш о входящем звонке
 *  - `ios_apns` — обычный APNs, не PushKit
 */
export type PushPlatform = "android" | "ios_voip" | "ios_apns";

/**
 * RegisterBody — представляет тело запроса `POST /push/register`.
 *
 * @property userId — идентификатор пользователя
 * @property pushToken — push-токен устройства
 * @property platform — платформа токена
 */
export type RegisterBody = {
  userId: number | string;
  pushToken: string;
  platform: PushPlatform;
};

/**
 * FcmCallPayload — представляет данные FCM-сообщения о входящем звонке.
 *
 * @property type — вид сообщения
 * @property callId — идентификатор звонка
 * @property sipCredentials — учётные данные SIP
 * @property address — адрес для показа
 */
export type FcmCallPayload = {
  type: "SIP_CALL";
  callId: string;
  sipCredentials: string;
  address: string;
};

/**
 * CallEndedReason — представляет причину пуша `SIP_CALL_ENDED`.
 * Это не исход дозвона из Redis: там свой набор значений.
 *
 * Значения:
 *  - `timeout` — никто не ответил за окно дозвона
 *  - `caller_hung_up` — панель сбросила, пока звонок ещё звонил
 *  - `answered_elsewhere` — трубку взяли
 *  - `declined_elsewhere` — отклонили через завершение звонка
 *  - `ended` — разговор уже шёл, и канал панели завершился
 */
export type CallEndedReason =
  | "timeout"
  | "caller_hung_up"
  | "answered_elsewhere"
  | "declined_elsewhere"
  | "ended";

/**
 * FcmCallEndedPayload — представляет данные FCM-сообщения о конце звонка.
 * `title` и `body` есть только у пропущенного: их показывает баннер.
 *
 * @property type — вид сообщения
 * @property callId — идентификатор звонка
 * @property address — адрес для показа
 * @property reason — причина конца звонка
 * @property title — заголовок баннера пропущенного
 * @property body — текст баннера пропущенного
 */
export type FcmCallEndedPayload = {
  type: "SIP_CALL_ENDED";
  callId: string;
  address?: string;
  reason: CallEndedReason;
  title?: string;
  body?: string;
};

/**
 * ApnsVoipCallPayload — представляет данные APNs VoIP о входящем звонке.
 * Плоские строки, те же ключи, что у данных FCM.
 *
 * @property type — вид сообщения
 * @property callId — идентификатор звонка
 * @property sipCredentials — учётные данные SIP
 * @property address — адрес для показа
 */
export type ApnsVoipCallPayload = {
  type: "SIP_CALL";
  callId: string;
  sipCredentials: string;
  address: string;
};

/**
 * ApnsCallEndedPayload — представляет данные обычного APNs о конце звонка.
 * Это не PushKit. `title` и `body` есть только у пропущенного.
 *
 * @property type — вид сообщения
 * @property callId — идентификатор звонка
 * @property reason — причина конца звонка
 * @property title — заголовок баннера пропущенного
 * @property body — текст баннера пропущенного
 */
export type ApnsCallEndedPayload = {
  type: "SIP_CALL_ENDED";
  callId: string;
  reason: CallEndedReason;
  title?: string;
  body?: string;
};

/**
 * PushTokenRecord — представляет сохранённый push-токен и его платформу.
 *
 * @property pushToken — токен устройства
 * @property platform — платформа токена
 */
export type PushTokenRecord = {
  pushToken: string;
  platform: PushPlatform;
};

/**
 * HangupReason — представляет причину сброса канала, которую принимает ARI в `DELETE /channels/{channelId}`.
 *
 * Значения:
 *  - `normal` — обычное завершение
 *  - `busy` — занято
 *  - `congestion` — перегрузка
 *  - `no_answer` — нет ответа
 *  - `timeout` — таймаут
 *  - `rejected` — отклонено
 *  - `unallocated` — номер не назначен
 *  - `normal_unspecified` — обычное завершение без уточнения
 *  - `number_incomplete` — номер набран не до конца
 *  - `codec_mismatch` — не совпали кодеки
 *  - `interworking` — сбой согласования сетей
 *  - `failure` — сбой
 *  - `answered_elsewhere` — ответили на другом устройстве
 */
export type HangupReason =
  | "normal"
  | "busy"
  | "congestion"
  | "no_answer"
  | "timeout"
  | "rejected"
  | "unallocated"
  | "normal_unspecified"
  | "number_incomplete"
  | "codec_mismatch"
  | "interworking"
  | "failure"
  | "answered_elsewhere";
