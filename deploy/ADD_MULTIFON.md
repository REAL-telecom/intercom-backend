## МультиФон Бизнес (исходящие звонки / OTP)

Учётные данные `MULTIFON_PHONE` и `MULTIFON_PASSWORD` задаются в **`.env`** (секция **MULTIFON**).

### 1) Перейти в каталог проекта и загрузить окружение

```bash
cd /opt/intercom-backend
set -a && source .env && set +a
```

### 2) Заполнить таблицы Postgres

**Auth:**

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
ON CONFLICT (id) DO UPDATE SET
  max_contacts = EXCLUDED.max_contacts,
  contact = EXCLUDED.contact;
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

**Registration**

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

### 3) Проверить данные в Postgres

```bash
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
SELECT id, username, realm FROM ps_auths WHERE id = 'multifon-auth';
"

docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
SELECT id, server_uri, client_uri, expiration FROM ps_registrations WHERE id = 'multifon-registration';
"
```

### 5) Применить настройки и проверить регистрацию в Asterisk

```bash
sudo asterisk -rx "module reload res_pjsip.so"
sudo asterisk -rx "pjsip show registrations ${MULTIFON_PHONE}"
```

Ожидается **Registered** для `multifon-registration`.

**Опциональные проверки (убедиться, что данные загрузились):`**

```bash
sudo asterisk -rx "pjsip show endpoint multifon"
sudo asterisk -rx "pjsip show aor multifon"
sudo asterisk -rx "pjsip show auth multifon"
```
