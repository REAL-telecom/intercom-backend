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
2. Создайте файл `.env` на основе `env.example` и заполните значения.
3. Установите права на выполнение и запустите установку:
   ```bash
   chmod +x deploy/install.sh
   sudo ./deploy/install.sh
   ```
   **Опционально:** чтобы смотреть лог установки в реальном времени.
   Откройте второе окно терминала и выполните:
   ```bash
   tail -f /opt/intercom-backend/install.log
   ```
4. Backend будет установлен и запущен как systemd сервис `intercom-backend`.
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

Используется динамическое создание временных endpoint’ов через Postgres.
Для этого в Asterisk включены:
- `res_config_pgsql`
- `sorcery.conf` + `extconfig.conf`

Таблицы для realtime создаются при старте backend (`ensureSchema`).

## 5) База данных

### Postgres
Используется для:
- `push_tokens` (сохранение Expo токенов)
- `users` и `calls` (минимальная модель)
- `ps_aors`, `ps_auths`, `ps_endpoints` (PJSIP realtime)

### Redis
Используется для:
- временных `callToken`
- привязки `channelId -> endpointId`

## 6) Поток вызова (MVP)

1. Домофон вызывает `Asterisk` → `Stasis(intercom)`
2. Backend получает `StasisStart` и ставит канал на hold
3. Создает временный SIP endpoint в Postgres (PJSIP realtime)
4. Генерирует `callToken`, сохраняет креды в Redis
5. Отправляет push через Expo
6. Клиент запрашивает `/calls/credentials`
7. Backend создает bridge и добавляет оба канала
8. По `StasisEnd` временный endpoint удаляется

## 7) env.example

В `.env` обязательно заполнить:
- `SERVER_DOMAIN`, `SERVER_IP`
- `ARI_USER`, `ARI_PASSWORD`
- `REDIS_PASSWORD`
- `TURN_USER`, `TURN_PASSWORD`
- `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`
- `REALPHONE` (идентификатор квартиры для MVP, например 1)
- `EXPO_ACCESS_TOKEN` (опционально, см. [инструкцию](instructions/GET_EXPO_TOKEN.md))

## 8) Важно

Этот MVP рассчитан на один домофон и одного пользователя.  
Дальше планируется:
- регистрация пользователей
- логика квартир/адресов
- приоритеты телефонов
- история звонков

