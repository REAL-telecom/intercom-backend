## Добавление домофона в PJSIP realtime

Переменные берутся из `.env` (секция **TEST PANEL / DOMOPHONE**).

### 1) Перейти в каталог и загрузить окружение

```bash
cd /opt/intercom-backend
set -a && source .env && set +a
```

### 2) Добавить записи в Postgres

**AOR**

```bash
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "INSERT INTO ps_aors (id, max_contacts) VALUES ('${TEST_DOMOPHONE_PJSIP_ID}', 1) ON CONFLICT (id) DO UPDATE SET max_contacts = 1;"
```

**Auth**

```bash
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "INSERT INTO ps_auths (id, auth_type, username, password) VALUES ('${TEST_DOMOPHONE_PJSIP_ID}', 'userpass', '${TEST_DOMOPHONE_AUTH_USERNAME}', '${TEST_DOMOPHONE_AUTH_PASSWORD}') ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username, password = EXCLUDED.password;"
```
**Endpoint**

```bash
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "INSERT INTO ps_endpoints (id, transport, aors, auth, context, templates, disallow, allow, direct_media, force_rport, rewrite_contact, rtp_symmetric) VALUES ('${TEST_DOMOPHONE_PJSIP_ID}','transport-udp','${TEST_DOMOPHONE_PJSIP_ID}','${TEST_DOMOPHONE_PJSIP_ID}','from-domophone','tpl_domophone','all','ulaw,alaw,h264','no','yes','yes','yes') ON CONFLICT (id) DO UPDATE SET context = EXCLUDED.context, templates = EXCLUDED.templates, allow = EXCLUDED.allow;"
```
### 3) Проверить данные в Postgres

```bash
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
SELECT id, max_contacts FROM ps_aors WHERE id = '${TEST_DOMOPHONE_PJSIP_ID}';
"

docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
SELECT id, username, password FROM ps_auths WHERE id = '${TEST_DOMOPHONE_PJSIP_ID}';
"

docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
SELECT id, transport, aors, auth FROM ps_endpoints WHERE id = '${TEST_DOMOPHONE_PJSIP_ID}';
"
```

### 4) Применить настройки Asterisk

```bash
sudo systemctl restart asterisk
```
### 5) Авторизоваться на панели и получить IP

В панели домофона в настройках SIP указать:
- SIP сервер: `SERVER_DOMAIN`
- SIP порт: `5060`
- Логин: `TEST_DOMOPHONE_AUTH_USERNAME`
- Пароль: `TEST_DOMOPHONE_AUTH_PASSWORD`

Дождитесь регистрации панели. После этого проверить появление контакта в Asterisk:

```bash
sudo asterisk -rx "pjsip show aor ${TEST_DOMOPHONE_PJSIP_ID}"
```

**Пример вывода:**

```text
Aor: domophone                                            1
Contact: domophone/sip:domophone-0xb6ade47c@XXX.XXX.XXX.XXX:5060

ParameterName        : ParameterValue
contact              : sip:domophone-0xb6ade47c@XXX.XXX.XXX.XXX:5060;x-ast-orig-host=100.66.251.62:5060
```

Из строки `contact` нужно взять IP адрес и добавить в .env `TEST_PANEL_IP`

```bash
nano .env
```

Затем перезагрузить окружение:

```bash
set -a && source .env && set +a
```

### 6) Привязка панели к адресу

`TEST_PANEL_ADDRESS_ID` — ID из таблицы `addresses` (см. [ADD_ADDRESS.md](ADD_ADDRESS.md)).

```bash
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "INSERT INTO panels (ip, address_id, created_at, updated_at) VALUES ('${TEST_PANEL_IP}'::inet, ${TEST_PANEL_ADDRESS_ID}, NOW(), NOW()) ON CONFLICT (ip) DO UPDATE SET address_id = EXCLUDED.address_id, updated_at = NOW();"
```

### 7) Проверить данные в Postgres

```bash
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
SELECT id, ip, address_id FROM panels WHERE ip = '${TEST_PANEL_IP}'::inet;
"
```
