# Intercom Backend (MVP)

Этот репозиторий содержит серверную часть умной домофонии:
- Backend (Node.js)
- Redis + Postgres (docker-compose)
- Конфиги Asterisk + Coturn
- Скрипт установки под новый сервер

## 1) Быстрый старт

1. Склонируйте репозиторий:
   ```bash
   git clone https://github.com/REAL-telecom/intercom-backend
   cd intercom-backend
   ```
2. Создайте файл `.env` на основе `.env.example` и заполните значения.
3. Скопируйте файл ключа Firebase (`*-firebase-adminsdk-*.json`) в корень репозитория на сервере. Без него скрипт установки не запустится. С локального компьютера:
   ```bash
   scp ./*-firebase-adminsdk-*.json USER@SERVER:/путь/к/intercom-backend/
   ```
   (подставьте пользователя, хост сервера и путь к склонированному репо на сервере.)
4. Установите права на выполнение и запустите установку:
   ```bash
   chmod +x deploy/install.sh
   sudo ./deploy/install.sh
   ```
   **Опционально:** чтобы смотреть лог установки в реальном времени.
   Откройте второе окно терминала и выполните:
   ```bash
   tail -f /opt/intercom-backend/install.log
   ```
5. Backend будет установлен и запущен как systemd сервис `intercom-backend`.
   Проверить статус:
   ```bash
   systemctl status intercom-backend
   ```

## 2) Что делает install.sh

- Устанавливает зависимости ОС
- Скачивает и собирает Asterisk
- Ставит Coturn
- Копирует конфиги Asterisk и Coturn из `/configs`
- Запускает Asterisk и Coturn как systemd сервисы
- Запускает Redis + Postgres через `docker compose`
- Копирует backend в `/opt/intercom-backend` и запускает как systemd сервис

## 3) Конфиги Asterisk/Coturn

Файлы в `configs/asterisk` и `configs/coturn` копируются в:
- `/etc/asterisk`
- `/etc/turnserver.conf`

**Важно:** значения домена/IP подставляются из `.env`.

### TLS/WSS
TLS в `http.conf` отключен по умолчанию.  
Если нужны WSS/HTTPS, включите `tlsenable` и укажите сертификаты.
Для TURN over TLS раскомментируйте `cert` и `pkey` в `configs/coturn/turnserver.conf`.

## 4) PJSIP Realtime

Используется динамическое создание временных endpoint’ов через Postgres (`res_config_pgsql`).

- В `configs/asterisk/extconfig.conf` заданы семейства `ps_endpoints`, `ps_auths`, `ps_aors`, `ps_registrations` → `pgsql,asterisk`.
- В `configs/asterisk/sorcery.conf` объекты привязаны к realtime так: в **`[res_pjsip]`** — `endpoint`, `auth`, `aor`; объект **`registration`** задаётся в отдельной секции **`[res_pjsip_outbound_registration]`** (не помещать `registration` под `[res_pjsip]` — в Asterisk 22 это приводит к падению при старте, см. [Asterisk #1651](https://github.com/asterisk/asterisk/issues/1651)).

Таблицы для realtime создаются при старте backend (`ensureSchema`).

## 5) База данных

### Postgres
Используется для:
- `push_tokens` (сохранение Expo токенов)
- `users` и `calls` (минимальная модель)
- `ps_aors`, `ps_auths`, `ps_endpoints`, `ps_registrations` (PJSIP realtime)

Инструкции по ручному заполнению realtime:

- [Добавление домофона](deploy/ADD_DOMOPHONE.md)
- [МультиФон / OTP](deploy/ADD_MULTIFON.md)

### Redis
Используется для:
- данных звонка по `callId` (channelId, endpointId, credentials)
- привязки `channelId` → session (callId, bridgeId, address)
- сессий временных endpoint'ов и отложенного originate

## 6) Поток вызова (MVP)

1. Домофон вызывает `Asterisk` → `Stasis(intercom)`
2. Backend получает `StasisStart`, создаёт `callId`, временный SIP endpoint (PJSIP realtime)
3. Сохраняет данные звонка в Redis по `callId`
4. Отправляет push с `callId` и SIP credentials
5. Backend создаёт bridge, добавляет канал домофона, ждёт регистрации клиента по endpoint
6. Originate к клиенту, добавление в bridge, answer домофона
7. По `StasisEnd` временный endpoint удаляется

## 7) API (актуальный контракт)

### `POST /auth/request-code`
Тело: `{ "phone": "+7..." }`

- `200`: `{"success":true,"message":"...","nextRequestAvailableAt":<unix>}` — unix-секунда, раньше которой не следует снова вызывать запрос кода (кулдаун интерфейса ~60 с); срок жизни OTP в ответе не передаётся.
- `400`: `{"success":false,"message":"..."}`
- `429`: `{"success":false,"message":"...","blockExpiresAt":<unix>}` + `Retry-After`
- `502`: `{"success":false,"message":"Не удалось совершить звонок."}`

Назначение: сгенерировать OTP, поставить задачу звонка в очередь, запустить worker.  
Контекст Asterisk для проигрывания цифр: `otp-out` в `extensions.conf`.

### `POST /auth/verify-code`
Тело: `{ "phone": "+7...", "code": "12345" }`

- `200`: `{"success":true,"message":"Пин подтверждён.","user":{...}}`
- `400`: `{"success":false,"message":"..."}`
- `410`: `{"success":false,"message":"Срок кода истек."}`
- `429`: `{"success":false,"message":"...","blockExpiresAt":<unix>}` + `Retry-After`

### `POST /calls/end`
Тело: `{ "callId": "..." }`

- `204` при успешном завершении
- побочный эффект: call помечается как `rejected`, pending-originate для endpoint очищается

## 8) `.env` / `.env.example`

В `.env` обязательно заполнить:
- `SERVER_DOMAIN`, `SERVER_IP`
- `ARI_USER`, `ARI_PASSWORD`
- `REDIS_PASSWORD`
- `TURN_USER`, `TURN_PASSWORD`
- `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`
- `FIREBASE_SERVICE_ACCOUNT_PATH` (путь к JSON ключу Firebase)
- `LOG_LEVEL` (опционально, по умолчанию `info`; допустимые: `debug|info|warn|error`)
- `EXPO_ACCESS_TOKEN` (опционально, см. [инструкцию](instructions/GET_EXPO_TOKEN.md))

## 9) Важно

Этот MVP рассчитан на один домофон и одного пользователя.  
Дальше планируется:
- регистрация пользователей
- логика квартир/адресов
- приоритеты телефонов
- история звонков
