# Инструкции по настройке после установки

Каталог содержит пошаговые сценарии для сервера с уже выполненным [install.sh](install.sh) и запущенным стеком (Asterisk, Postgres, backend). Все команды с БД предполагают каталог проекта и подгрузку переменных:

## Рекомендуемый порядок

1. **[ADD_MULTIFON.md](ADD_MULTIFON.md)** — исходящий SIP-транк (МультиФон). Без него не будут работать OTP-звонки на номера пользователей.

2. **[ADD_ADDRESS.md](ADD_ADDRESS.md)** — запись адреса в таблицу `addresses`. Сохраните полученный `id` — он понадобится для привязки панели и пользователя.

3. **[ADD_DOMOPHONE.md](ADD_DOMOPHONE.md) — регистрация панели домофона в Asterisk:

Добавление записей в ps_aors, ps_auths, ps_endpoints

Перезагрузка Asterisk

Авторизация панели и получение её IP

Привязка панели к адресу (таблица panels)

4. **[ADD_USER.md](ADD_USER.md)** — ппривязка существующего пользователя (после OTP-верификации) к адресу и квартире.

## Прочее

Патч [patches/asterisk-22.11.0-pgsql-store-skip-unknown-columns.patch](patches/asterisk-22.11.0-pgsql-store-skip-unknown-columns.patch) учит драйвер PostgreSQL при вставке пропускать колонки, которых нет в таблице. Имя `100rel` без кавычек иначе ломает создание временной учётки. Свежий [install.sh](install.sh) накладывает патч до сборки. На уже собранном Asterisk шаги в [PATCH_PGSQL_STORE.md](PATCH_PGSQL_STORE.md).

- **[DOMAIN_MIGRATION.md](DOMAIN_MIGRATION.md)** — смена домена на уже развёрнутом сервере (серт, `.env`, Asterisk/TURN, клиенты). Шаблоны с `__SERVER_DOMAIN__` не трогать.
- **[TEST_BLOCKING_E2E.md](TEST_BLOCKING_E2E.md)** — ручное тестирование rate limits и fail2ban. Не является обязательной частью настройки.

## См. также

- Установка с нуля: [README.md](../README.md) в корне репозитория.
- Fail2ban: [configs/fail2ban/README.md](../configs/fail2ban/README.md).
