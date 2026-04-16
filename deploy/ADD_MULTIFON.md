## МультиФон Бизнес (исходящие звонки / OTP)

Регистрация SIP и учётные данные транка хранятся в таблицах PostgreSQL `ps_*` (realtime PJSIP). Звуки OTP лежат в репозитории в `configs/asterisk/sounds/ru/custom/otp/` и при установке копируются в `/var/lib/asterisk/sounds/ru/custom/otp/` (см. `deploy/install.sh`).

Убедитесь, что в `/etc/asterisk` уже развёрнуты из репозитория:

- `extconfig.conf` — строка `ps_registrations => pgsql,asterisk`
- `sorcery.conf` — секция `[res_pjsip_outbound_registration]` и строка `registration=realtime,ps_registrations` (не под `[res_pjsip]`, см. [Asterisk #1651](https://github.com/asterisk/asterisk/issues/1651))


После первого запуска бэкенда таблицы `ps_*` и `ps_registrations` создаются через `ensureSchema` в `src/store/postgres.ts`. На чистой БД достаточно заполнить строки ниже.

### 1) Переменные Postgres

В каталоге проекта с `.env`:

```bash
cd /opt/intercom-backend
set -a && source .env && set +a
```

Дальше в командах используются `$POSTGRES_USER` и `$POSTGRES_DB`.

### 2) Заполнение Multifon (номер и пароль берутся из `$MULTIFON_PHONE` / `$MULTIFON_PASSWORD`)

**Auth** — `realm = BREDBAND` совпадает с `Proxy-Authenticate` у SBC; при отказе digest попробуйте `UPDATE ps_auths SET realm = NULL WHERE id = 'multifon-auth';`.

```bash
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
INSERT INTO ps_auths (id, auth_type, username, password, realm)
VALUES ('multifon-auth', 'userpass', '${MULTIFON_PHONE}', '${MULTIFON_PASSWORD}', 'BREDBAND')
ON CONFLICT (id) DO UPDATE SET
  auth_type = EXCLUDED.auth_type,
  username = EXCLUDED.username,
  password = EXCLUDED.password,
  realm = EXCLUDED.realm;
"
```

**AOR:**

```bash
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
INSERT INTO ps_aors (id, max_contacts, contact)
VALUES ('multifon-aor', 1, 'sip:sbc.megafon.ru:5060')
ON CONFLICT (id) DO UPDATE SET max_contacts = EXCLUDED.max_contacts, contact = EXCLUDED.contact;
"
```

**Endpoint:**

```bash
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
INSERT INTO ps_endpoints (
  id, transport, aors, auth, outbound_auth, context,
  disallow, allow, direct_media, force_rport, rewrite_contact, rtp_symmetric, ice_support,
  from_user, from_domain, callerid
) VALUES (
  'multifon',
  'transport-udp',
  'multifon-aor',
  'multifon-auth',
  'multifon-auth',
  'from-multifon',
  'all',
  'ulaw,alaw,g729',
  'no',
  'yes',
  'yes',
  'yes',
  'yes',
  '${MULTIFON_PHONE}',
  'multifon.ru',
  '${MULTIFON_PHONE}'
)
ON CONFLICT (id) DO UPDATE SET
  transport = EXCLUDED.transport,
  aors = EXCLUDED.aors,
  auth = EXCLUDED.auth,
  outbound_auth = EXCLUDED.outbound_auth,
  context = EXCLUDED.context,
  disallow = EXCLUDED.disallow,
  allow = EXCLUDED.allow,
  direct_media = EXCLUDED.direct_media,
  force_rport = EXCLUDED.force_rport,
  rewrite_contact = EXCLUDED.rewrite_contact,
  rtp_symmetric = EXCLUDED.rtp_symmetric,
  ice_support = EXCLUDED.ice_support,
  from_user = EXCLUDED.from_user,
  from_domain = EXCLUDED.from_domain,
  callerid = EXCLUDED.callerid;
"
```

**Registration** — после переноса в БД секцию `[multifon-registration]` в `pjsip.conf` нужно удалить или закомментировать, иначе дублирование.

```bash
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
INSERT INTO ps_registrations (id, transport, outbound_auth, server_uri, client_uri, expiration, retry_interval)
VALUES (
  'multifon-registration',
  'transport-udp',
  'multifon-auth',
  'sip:sbc.megafon.ru:5060',
  'sip:${MULTIFON_PHONE}@multifon.ru',
  180,
  60
)
ON CONFLICT (id) DO UPDATE SET
  transport = EXCLUDED.transport,
  outbound_auth = EXCLUDED.outbound_auth,
  server_uri = EXCLUDED.server_uri,
  client_uri = EXCLUDED.client_uri,
  expiration = EXCLUDED.expiration,
  retry_interval = EXCLUDED.retry_interval;
"
```

### 3) Статический `pjsip.conf`

Не дублируйте в файле объекты, которые уже в БД: `[multifon-auth]`, `[multifon-aor]`, `[multifon]` (endpoint), `[multifon-registration]`. Оставьте `[transport-udp]`, `[global]`, при необходимости `[multifon-identify]`.

### 4) Проверка данных в Postgres

```bash
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT id, username, realm FROM ps_auths WHERE id = 'multifon-auth';"
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT * FROM ps_registrations WHERE id = 'multifon-registration';"
```

### 5) Проверка в Asterisk

После изменения `sorcery.conf` или `extconfig.conf` выполните `sudo systemctl restart asterisk` (одного `module reload` может быть недостаточно).

```bash
sudo asterisk -rx "module reload res_pjsip.so"
sudo asterisk -rx "pjsip show auths"
sudo asterisk -rx "pjsip show endpoint multifon"
sudo asterisk -rx "pjsip show registrations"
sudo asterisk -rx "pjsip send register multifon-registration"
```

Ожидается **Registered** для `multifon-registration`.

### 6) Звуки OTP

Файлы должны быть **8 kHz, mono, 16-bit PCM WAV**. Пример проверки:

```bash
file /var/lib/asterisk/sounds/ru/custom/otp/intro.wav
```

### 7) Тест исходящего сценария (пример)

В `extensions.conf` контекст с цепочкой `Playback(custom/otp/...)` без второго `Dial` на тот же номер; затем в CLI:

```text
channel originate PJSIP/79000000000@multifon extension s@otp-out-test
```

Подставьте реальный номер вместо `79000000000`.
