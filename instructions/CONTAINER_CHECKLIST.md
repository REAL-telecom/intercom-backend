# Чек‑лист: контейнеризация `intercom-backend` + TLS + Coturn (TURN/TLS, WSS) + Traefik

Эта инструкция — чтобы **не потерять “где что менять”** при переходе к Docker/Traefik и при включении TLS для Coturn.

## 0) Зафиксируй целевую схему (важные развилки)

- **Asterisk**: оставляем **на хосте** (systemd), как сейчас. Контейнеризация Asterisk возможна, но NAT/RTP/ICE и доступ к UDP‑портам обычно усложняют отладку.
- **intercom-backend**: переносим в контейнер (Node).
- **Postgres/Redis**: уже есть в `docker-compose.yml` — оставляем контейнерными.
- **TLS/HTTPS для API**: делаем через Traefik (443 → backend:3000).
- **Coturn**: есть два реалистичных варианта:
  - **Вариант 1 (рекомендовано на старте)**: Coturn **на хосте** (systemd) + сертификаты от Certbot + автоперезапуск при обновлении.
  - **Вариант 2**: Coturn **в контейнере** + сертификаты “выгружаем” из Traefik (через cert‑dumper/скрипт) + рестарт Coturn при обновлении.

Важно: **один IP:443** одновременно под HTTPS API и под TURN/TLS “в лоб” занять нельзя. Поэтому:
- Если нужен TURN/TLS строго на `443`, потребуется **отдельный IP** (или иной мультиплексор/архитектура).
- Практичнее: HTTPS на `443`, TURN/TLS на `5349`, TURN/UDP на `3478` (как у тебя в UFW).

## 1) DNS и порты (до Docker)

- **DNS**:
  - `A domophone.site -> <SERVER_IP>`
  - (опционально) отдельный домен под TURN, например `turn.domophone.site -> <SERVER_IP>`
- **UFW** (prod‑режим):
  - Оставить открытыми: `22/tcp`, `80/tcp`, `443/tcp`, `3478/udp`, `3478/tcp`, `5349/tcp`, `10000:20000/udp`, `5060/udp`, `8089/tcp`
  - **Закрыть внешний 3000/tcp** после того, как Traefik заработает и проксирует на 3000:
    - `ufw delete allow 3000/tcp` (если открывал на время)

Проверки:

```bash
ss -lntp | egrep ':(80|443|3000)\s'
ufw status verbose
```

## 2) Что поменять в `intercom-backend` перед контейнеризацией

### 2.1) Хосты Redis/Postgres/ARI НЕ должны быть “захардкожены в localhost”

Сейчас в коде `src/config/env.ts` есть значения по умолчанию на `127.0.0.1` для:
- `redisHost`
- `postgres.host`
- `ariHost`

При запуске бекенда в контейнере это сломает соединение с контейнерными `redis/postgres`.

План изменения:
- Добавить env‑переменные (с дефолтом на `127.0.0.1`, чтобы не ломать текущий host‑деплой):
  - `REDIS_HOST` (в compose будет `redis`)
  - `POSTGRES_HOST` (в compose будет `postgres`)
  - `ARI_HOST` (если Asterisk на хосте: либо `host.docker.internal` (не всегда есть на Linux), либо “host gateway”, либо host network)

Минимальный чек‑лист значений в Docker:
- `REDIS_HOST=redis`
- `POSTGRES_HOST=postgres`
- `ARI_HOST=<IP хоста в docker-сети>` (см. пункт 4.3)

### 2.2) Переменные окружения (единый список)

Смотри `.env.example`. В контейнерный запуск должны попасть как минимум:
- `SERVER_DOMAIN`
- `SERVER_IP`
- `ARI_USER`, `ARI_PASSWORD`
- `REDIS_PASSWORD`
- `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`
- `REALPHONE`
- `EXPO_ACCESS_TOKEN` (опционально, но лучше задать)
- плюс новые (после правки кода): `REDIS_HOST`, `POSTGRES_HOST`, `ARI_HOST`

## 3) Traefik: HTTPS на 443 для бекенда

### 3.1) Где это настраивать

- Добавить сервис `traefik` в `docker-compose.yml` (отдельный compose файл или расширение текущего).
- Добавить сервис `backend` (Node), и прокинуть его на внутренний порт `3000` **без** публикации наружу.
- Настроить Traefik router по домену `domophone.site` → сервис `backend:3000`.

### 3.2) Важные детали

- Let’s Encrypt (ACME):
  - HTTP‑01: требует открыть `80` наружу.
  - DNS‑01: удобнее, если не хочешь поднимать порт 80, но нужен доступ к DNS‑провайдеру.
- После включения Traefik:
  - Снаружи должно открываться: `https://domophone.site/health`
  - Прямой `http://<IP>:3000/health` лучше закрыть фаерволом.

Проверки:

```bash
curl -vk "https://domophone.site/health"
curl -vk "https://domophone.site/push/register" -H "Content-Type: application/json" \
  -d '{"userId":"1001","expoPushToken":"ExponentPushToken[TEST]","platform":"android","deviceId":"test"}'
```

## 4) Coturn: TLS/WSS и сертификаты

У тебя шаблон `configs/coturn/turnserver.conf` с параметрами:
- `listening-ip`, `external-ip`, `realm`
- `tls-listening-port=5349`
- строки сертификата сейчас закомментированы:
  - `cert=.../fullchain.pem`
  - `pkey=.../privkey.pem`

### 4.1) Вариант 1 (рекомендовано сначала): Certbot на хосте + Coturn systemd

1) Получить сертификат:
- Если Traefik ещё не поднят: можно `certbot --nginx`/`--standalone` (на 80).
- Если Traefik будет на 80/443: лучше DNS‑01, чтобы не конфликтовать с портами.

2) Включить TLS в `/etc/turnserver.conf`:
- Раскомментировать и подставить домен:
  - `cert=/etc/letsencrypt/live/<DOMAIN>/fullchain.pem`
  - `pkey=/etc/letsencrypt/live/<DOMAIN>/privkey.pem`

3) Перезапустить Coturn:

```bash
systemctl restart coturn
systemctl status coturn --no-pager | sed -n '1,50p'
```

4) Автоперезапуск при обновлении сертификата (Certbot):
- Создать deploy‑hook (пример):
  - `/etc/letsencrypt/renewal-hooks/deploy/restart-coturn.sh`
  - содержимое:

```bash
#!/bin/sh
systemctl restart coturn
```

```bash
chmod +x /etc/letsencrypt/renewal-hooks/deploy/restart-coturn.sh
certbot renew --dry-run
```

### 4.2) Вариант 2: Traefik выдаёт сертификат, Coturn берёт его из файлов

Traefik хранит сертификаты в `acme.json`. Coturnу нужны **файлы** `fullchain.pem/privkey.pem`.

Рабочая схема:
- Traefik выдаёт/обновляет сертификат.
- Отдельный контейнер/скрипт “дампит” (экспортирует) сертификат из `acme.json` в папку на диске.
- Coturn монтирует эту папку и читает `cert/pkey`.
- При изменении файлов — делаем `docker compose restart coturn` (или `systemctl restart`, если Coturn на хосте).

Чек‑лист:
- Выбрать инструмент “cert dumper” (например, `traefik-certs-dumper`) или написать свой экспорт.
- Гарантировать права доступа, чтобы Coturn мог читать приватный ключ.
- Настроить перезапуск Coturn после экспорта (cron/systemd timer/встроенный watcher).

### 4.3) Coturn и WSS (TURN over WebSockets)

TURN‑over‑WSS используют, когда сети режут “обычный” TURN/TCP и остаётся только HTTPS‑подобный трафик.

Но есть ограничение: **443 уже занят HTTPS API** (Traefik). Поэтому заранее реши:
- **WSS не обязателен** → оставь TURN/TLS на `5349` (проще).
- **WSS обязателен на 443** → нужен:
  - либо **второй IP** под Coturn:443
  - либо более сложная схема маршрутизации/разделения (не “из коробки” для всех клиентов)

## 5) Что поменять в приложении (Expo / example)

### 5.1) Базовый URL бекенда

Сейчас по умолчанию:
- `example/src/config/backend.ts`: `https://domophone.site`
- и именно туда приложение шлёт регистрацию пуш‑токена (`/push/register`)

Для прод‑режима:
- оставить `EXPO_PUBLIC_BACKEND_URL=https://domophone.site`

Для временного режима без TLS (не рекомендуется, но полезно для отладки):
- `EXPO_PUBLIC_BACKEND_URL=http://<SERVER_IP>:3000`

Важно для Android: на некоторых сборках **cleartext HTTP** может быть заблокирован. Тогда временный режим через `http://...` даст тот же симптом `Network request failed`.

### 5.2) Проверка “падает на клиенте или на сервере”

- Если клиент пишет `Network request failed` при регистрации — сначала проверь:

```bash
curl -vk "https://domophone.site/health"
curl -vk "https://domophone.site/push/register" -H "Content-Type: application/json" \
  -d '{"userId":"1001","expoPushToken":"ExponentPushToken[TEST]","platform":"android","deviceId":"test"}'
```

- Если регистрация проходит, но уведомления не приходят — смотреть серверные логи отправки в Expo:
  - Бекенд отправляет в `https://exp.host/--/api/v2/push/send`
  - Проверка из сервера:

```bash
curl -v "https://exp.host/--/api/v2/push/send" -H "Content-Type: application/json" -d "[]"
```

## 6) Мини‑чек‑лист финального “prod” состояния

- **Снаружи открыто**: 80/443 (Traefik), 3478(udp/tcp), 5349(tcp), 10000‑20000/udp, 5060/udp, 8089/tcp
- **Снаружи закрыто**: 3000/tcp, 5432/tcp, 6379/tcp
- **HTTPS работает**: `curl -vk https://domophone.site/health` → 200
- **Регистрация пуш‑токена работает**: POST `/push/register` → `{ ok: true }`
- **Coturn TLS** включён (если нужен): `cert/pkey` настроены, сервис перезапускается на renew
- **Автообновление сертификата**: `certbot renew --dry-run` (или Traefik ACME) + рестарт Coturn при обновлении

