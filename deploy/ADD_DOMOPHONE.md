## Добавление домофона в PJSIP realtime

Эта инструкция добавляет статический домофон в таблицы `ps_*` (Postgres), чтобы он мог регистрироваться на Asterisk по логину/паролю.

Файлы `sorcery.conf` и `extconfig.conf` для realtime должны совпадать с репозиторием (см. раздел PJSIP Realtime в [README.md](../README.md)). Исходящая регистрация SIP-транка (МультиФон) настраивается отдельно — [ADD_MULTIFON.md](ADD_MULTIFON.md).

### 1) Добавить записи через docker compose (на сервере)
```bash
cd /opt/intercom-backend
set -a && source .env && set +a
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "INSERT INTO ps_aors (id, max_contacts) VALUES ('domophone', 1) ON CONFLICT (id) DO UPDATE SET max_contacts = 1;"
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "INSERT INTO ps_auths (id, auth_type, username, password) VALUES ('domophone', 'userpass', 'domophone', 'password123') ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username, password = EXCLUDED.password;"
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "INSERT INTO ps_endpoints (id, transport, aors, auth, context, templates, disallow, allow, direct_media, force_rport, rewrite_contact, rtp_symmetric) VALUES ('domophone','transport-udp','domophone','domophone','from-domophone','tpl_domophone','all','ulaw,alaw,h264','no','yes','yes','yes') ON CONFLICT (id) DO UPDATE SET context = EXCLUDED.context, templates = EXCLUDED.templates, allow = EXCLUDED.allow;"
```

### 2) Параметры для замены
Замените `domophone` / `password123` на фактические логин и пароль домофона.

### 2.1) Привязка панели к адресу для маршрутизации вызова
Схема таблиц `addresses` и `panels` создаётся бэкендом автоматически (`ensureSchema`).
Возьмите `address_id` из [ADD_ADDRESS.md](ADD_ADDRESS.md), IP панели — из [GET_DOMOPHONE_IP.md](GET_DOMOPHONE_IP.md) (переменная `$PANEL_IP`).

```bash
cd /opt/intercom-backend
set -a && source .env && set +a
test -n "$PANEL_IP"
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "INSERT INTO panels (ip, address_id, created_at, updated_at) VALUES ('$PANEL_IP'::inet, 1, NOW(), NOW()) ON CONFLICT (ip) DO UPDATE SET address_id = EXCLUDED.address_id, updated_at = NOW();"
```

### 3) Проверка данных в Postgres
```bash
set -a && source .env && set +a
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT * FROM ps_aors WHERE id='domophone';"
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT * FROM ps_auths WHERE id='domophone';"
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT * FROM ps_endpoints WHERE id='domophone';"
test -n "$PANEL_IP"
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT id, ip, address_id, created_at, updated_at FROM panels WHERE ip='$PANEL_IP'::inet;"
```

Пример вывода:
```
    id     | max_contacts | contact 
-----------+--------------+---------
 domophone |            1 | 
(1 row)

    id     | auth_type | username  |  password   
-----------+-----------+-----------+-------------
 domophone | userpass  | domophone | password123
(1 row)

    id     |   transport   |   aors    |   auth    |    context     | disallow |     allow      | mailboxes |   templates   | direct_media | force_rport | rewrite_contact | rtp_symmetric 
-----------+---------------+-----------+-----------+----------------+----------+----------------+-----------+---------------+--------------+-------------+-----------------+---------------
 domophone | transport-udp | domophone | domophone | from-domophone | all      | ulaw,alaw,h264 |           | tpl_domophone | no           | yes         | yes             | yes
(1 row)

 id |      ip      | address_id |          created_at           |          updated_at
----+--------------+------------+-------------------------------+-------------------------------
  1 | X.X.X.X      |          1 | 2026-01-01 00:00:00+00        | 2026-01-01 00:00:00+00
(1 row)
```

### 5) Проверка в Asterisk
```bash
asterisk -rx "pjsip show endpoint domophone"
asterisk -rx "pjsip show auths"
asterisk -rx "pjsip show aors"
asterisk -rx "pjsip show contacts"
```
