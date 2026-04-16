# Инструкции по настройке после установки

Каталог содержит пошаговые сценарии для сервера с уже выполненным [install.sh](install.sh) и запущенным стеком (Asterisk, Postgres, backend). Все команды с БД предполагают каталог проекта и подгрузку переменных:

```bash
cd /opt/intercom-backend
set -a && source .env && set +a
```

Значения для примеров (`MULTIFON_*`, адрес, домофон, панель, пользователь) задаются в **`.env`** в корне репозитория; шаблон — [`.env.example`](../.env.example).

## Рекомендуемый порядок

1. **[ADD_MULTIFON.md](ADD_MULTIFON.md)** — исходящий SIP-транк (МультиФон): нужен для OTP-звонков на номера и исходящих сценариев.

2. **[ADD_ADDRESS.md](ADD_ADDRESS.md)** — запись адреса в таблицу `addresses`. Сохраните `id` строки (для `TEST_PANEL_ADDRESS_ID` и привязки пользователя).

3. **[ADD_DOMOPHONE.md](ADD_DOMOPHONE.md) (часть 1)** — записи `ps_aors` / `ps_auths` / `ps_endpoints` для панели домофона из переменных `TEST_DOMOPHONE_*` в `.env`.

4. Дождитесь регистрации панели на Asterisk (питание/сеть, корректные учётные данные).

5. **[GET_DOMOPHONE_IP.md](GET_DOMOPHONE_IP.md)** — узнайте IP панели, пропишите **`TEST_PANEL_IP`** в `.env`, выполните `source .env`.

6. **[ADD_DOMOPHONE.md](ADD_DOMOPHONE.md) (часть 2)** — привязка панели к адресу: `INSERT` в `panels` с `TEST_PANEL_IP` и **`TEST_PANEL_ADDRESS_ID`** (тот же `id`, что в шаге 2).

7. **[ADD_USER.md](ADD_USER.md)** — после успешной OTP-регистрации в приложении привяжите пользователя к адресу и квартире (`TEST_USER_*` в `.env`).

Порядок шагов 2 и 3 можно поменять местами, но **`TEST_PANEL_ADDRESS_ID`** (и привязка панели к адресу) должны ссылаться на существующую строку в `addresses`. Без **Multifon** (шаг 1) исходящие звонки на номер для OTP работать не будут.

## Прочее

- **[TEST_BLOCKING_E2E.md](TEST_BLOCKING_E2E.md)** — сценарии для **ручного** тестирования прикладных лимитов (частота запросов `/auth/*`, Redis, ответы 429 и поля `blockExpiresAt` / `nextRequestAvailableAt`). Не часть обязательной настройки домофона.

## См. также

- Установка с нуля: [README.md](../README.md) в корне репозитория.
- Fail2ban: [configs/fail2ban/README.md](../configs/fail2ban/README.md).
