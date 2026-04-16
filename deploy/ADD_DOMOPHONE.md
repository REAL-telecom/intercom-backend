## Добавление домофона в PJSIP realtime

Эта инструкция добавляет статический домофон в таблицы `ps_*` (Postgres), чтобы он мог регистрироваться на Asterisk по логину/паролю.

Файлы `sorcery.conf` и `extconfig.conf` для realtime должны совпадать с репозиторием (см. раздел PJSIP Realtime в [README.md](../README.md)). Исходящая регистрация SIP-транка (МультиФон) настраивается отдельно — [ADD_MULTIFON.md](ADD_MULTIFON.md).

В **`.env`** задайте переменные секции **TEST PANEL / DOMOPHONE** (см. [`.env.example`](../.env.example)): `TEST_DOMOPHONE_PJSIP_ID`, `TEST_DOMOPHONE_AUTH_USERNAME`, `TEST_DOMOPHONE_AUTH_PASSWORD`, для привязки панели к адресу — `TEST_PANEL_ADDRESS_ID` и после шага [GET_DOMOPHONE_IP.md](GET_DOMOPHONE_IP.md) — `TEST_PANEL_IP`.

### 1) Добавить записи через docker compose (на сервере)

```bash
cd /opt/intercom-backend
set -a && source .env && set +a
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "INSERT INTO ps_aors (id, max_contacts) VALUES ('${TEST_DOMOPHONE_PJSIP_ID}', 1) ON CONFLICT (id) DO UPDATE SET max_contacts = 1;"
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "INSERT INTO ps_auths (id, auth_type, username, password) VALUES ('${TEST_DOMOPHONE_PJSIP_ID}', 'userpass', '${TEST_DOMOPHONE_AUTH_USERNAME}', '${TEST_DOMOPHONE_AUTH_PASSWORD}') ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username, password = EXCLUDED.password;"
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "INSERT INTO ps_endpoints (id, transport, aors, auth, context, templates, disallow, allow, direct_media, force_rport, rewrite_contact, rtp_symmetric) VALUES ('${TEST_DOMOPHONE_PJSIP_ID}','transport-udp','${TEST_DOMOPHONE_PJSIP_ID}','${TEST_DOMOPHONE_PJSIP_ID}','from-domophone','tpl_domophone','all','ulaw,alaw,h264','no','yes','yes','yes') ON CONFLICT (id) DO UPDATE SET context = EXCLUDED.context, templates = EXCLUDED.templates, allow = EXCLUDED.allow;"
```

### 2) Привязка панели к адресу для маршрутизации вызова

Схема таблиц `addresses` и `panels` создаётся бэкендом автоматически (`ensureSchema`).

- **`TEST_PANEL_ADDRESS_ID`** — `id` из [ADD_ADDRESS.md](ADD_ADDRESS.md).
- **`TEST_PANEL_IP`** — после регистрации панели в Asterisk, см. [GET_DOMOPHONE_IP.md](GET_DOMOPHONE_IP.md).

```bash
cd /opt/intercom-backend
set -a && source .env && set +a
test -n "$TEST_PANEL_IP"
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "INSERT INTO panels (ip, address_id, created_at, updated_at) VALUES ('${TEST_PANEL_IP}'::inet, ${TEST_PANEL_ADDRESS_ID}, NOW(), NOW()) ON CONFLICT (ip) DO UPDATE SET address_id = EXCLUDED.address_id, updated_at = NOW();"
```

### 3) Проверка данных в Postgres

```bash
cd /opt/intercom-backend
set -a && source .env && set +a
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT * FROM ps_aors WHERE id='${TEST_DOMOPHONE_PJSIP_ID}';"
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT * FROM ps_auths WHERE id='${TEST_DOMOPHONE_PJSIP_ID}';"
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT * FROM ps_endpoints WHERE id='${TEST_DOMOPHONE_PJSIP_ID}';"
test -n "$TEST_PANEL_IP"
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT id, ip, address_id, created_at, updated_at FROM panels WHERE ip='${TEST_PANEL_IP}'::inet;"
```

Пример вывода (идентификаторы и пароль совпадают с вашими значениями из `.env`):

```
    id     | max_contacts | contact 
-----------+--------------+---------
 <id>     |            1 | 
(1 row)

    id     | auth_type | username  |  password   
-----------+-----------+-----------+-------------
 <id>     | userpass  | <user>    | <из .env>
(1 row)

    id     |   transport   |   aors    |   auth    |    context     | disallow |     allow      | mailboxes |   templates   | direct_media | force_rport | rewrite_contact | rtp_symmetric 
-----------+---------------+-----------+-----------+----------------+----------+----------------+-----------+---------------+--------------+-------------+-----------------+---------------
 <id>     | transport-udp | <id>      | <id>      | from-domophone | all      | ulaw,alaw,h264 |           | tpl_domophone | no           | yes         | yes             | yes
(1 row)

 id |      ip      | address_id |          created_at           |          updated_at
----+--------------+------------+-------------------------------+-------------------------------
  1 | X.X.X.X/32   |          1 | 2026-01-01 00:00:00+00        | 2026-01-01 00:00:00+00
(1 row)
```

### 4) Проверка в Asterisk

```bash
cd /opt/intercom-backend
set -a && source .env && set +a
sudo asterisk -rx "pjsip show endpoint ${TEST_DOMOPHONE_PJSIP_ID}"
sudo asterisk -rx "pjsip show auths"
sudo asterisk -rx "pjsip show aors"
sudo asterisk -rx "pjsip show contacts"
```
