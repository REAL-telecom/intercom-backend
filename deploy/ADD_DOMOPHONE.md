## Добавление домофона в PJSIP realtime

Эта инструкция добавляет статический домофон в таблицы `ps_*` (Postgres), чтобы он мог регистрироваться на Asterisk по логину/паролю.

Файлы `sorcery.conf` и `extconfig.conf` для realtime должны совпадать с репозиторием (см. раздел PJSIP Realtime в [README.md](../README.md)). Исходящая регистрация SIP-транка (МультиФон) настраивается отдельно — [ADD_MULTIFON.md](ADD_MULTIFON.md).

### 1) Добавить записи через docker compose (на сервере)
```bash
cd /opt/intercom-backend
docker compose exec -T postgres psql -U postgres -d intercom -c "INSERT INTO ps_aors (id, max_contacts) VALUES ('domophone', 1) ON CONFLICT (id) DO UPDATE SET max_contacts = 1;"
docker compose exec -T postgres psql -U postgres -d intercom -c "INSERT INTO ps_auths (id, auth_type, username, password) VALUES ('domophone', 'userpass', 'domophone', 'password123') ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username, password = EXCLUDED.password;"
docker compose exec -T postgres psql -U postgres -d intercom -c "INSERT INTO ps_endpoints (id, transport, aors, auth, context, templates, disallow, allow, direct_media, force_rport, rewrite_contact, rtp_symmetric) VALUES ('domophone','transport-udp','domophone','domophone','from-domophone','tpl_domophone','all','ulaw,alaw,h264','no','yes','yes','yes') ON CONFLICT (id) DO UPDATE SET context = EXCLUDED.context, templates = EXCLUDED.templates, allow = EXCLUDED.allow;"
```

### 2) Параметры для замены
Замените `domophone` / `password123` на фактические логин и пароль домофона.

### 2.1) Заполнение адреса для subtitle
Адрес отображается в приложении как подзаголовок входящего вызова. Таблица `endpoint_addresses` создаётся бэкендом при старте. Значение `endpoint_id` должно совпадать с `id` домофона в `ps_endpoints` (например `domophone`). Адрес замените на нужный.

```bash
cd /opt/intercom-backend
docker compose exec -T postgres psql -U postgres -d intercom -c "INSERT INTO endpoint_addresses (endpoint_id, address) VALUES ('domophone', 'ул. Куликова, д. 73 корп. 2') ON CONFLICT (endpoint_id) DO UPDATE SET address = EXCLUDED.address;"
```

### 3) Проверка данных в Postgres
```bash
docker compose exec -T postgres psql -U postgres -d intercom -c "SELECT * FROM ps_aors WHERE id='domophone';"
docker compose exec -T postgres psql -U postgres -d intercom -c "SELECT * FROM ps_auths WHERE id='domophone';"
docker compose exec -T postgres psql -U postgres -d intercom -c "SELECT * FROM ps_endpoints WHERE id='domophone';"
docker compose exec -T postgres psql -U postgres -d intercom -c "SELECT * FROM endpoint_addresses WHERE endpoint_id='domophone';"
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

 endpoint_id |           address            
-------------+-----------------------------
 domophone   | ул. Куликова, д. 73 корп. 2
(1 row)
```

### 5) Проверка в Asterisk
```bash
asterisk -rx "pjsip show endpoint domophone"
asterisk -rx "pjsip show auths"
asterisk -rx "pjsip show aors"
asterisk -rx "pjsip show contacts"
```
