## Получение IP домофона после регистрации

Эта инструкция помогает получить текущий IP зарегистрированной панели в Asterisk и сохранить его в переменную **`TEST_PANEL_IP`** для использования в [ADD_DOMOPHONE.md](ADD_DOMOPHONE.md).

Переменная задаётся в **`.env`** на сервере (см. [`.env.example`](../.env.example), секция **TEST PANEL / DOMOPHONE**).

### 1) Подгрузить окружение

```bash
cd /opt/intercom-backend
set -a && source .env && set +a
```

### 2) Проверить контакты в Asterisk

```bash
sudo asterisk -rx "pjsip show contacts"
```

Найдите строку контакта нужной панели (например `Aor: <ваш TEST_DOMOPHONE_PJSIP_ID>`). В адресе будет вид `sip:<username>@X.X.X.X:PORT`.

### 3) Записать IP в `.env`

Откройте `/opt/intercom-backend/.env` и задайте (подставьте найденный IP):

```dotenv
TEST_PANEL_IP=X.X.X.X
```

Снова выполните:

```bash
set -a && source .env && set +a
test -n "$TEST_PANEL_IP" && echo "TEST_PANEL_IP=$TEST_PANEL_IP"
```

Если переменная пустая — повторите шаг 2. Альтернатива на одну сессию: `export TEST_PANEL_IP="X.X.X.X"` (без записи в `.env`).

### 4) Быстрая проверка

```bash
test -n "$TEST_PANEL_IP" && echo "TEST_PANEL_IP=$TEST_PANEL_IP"
```

### 5) Использование в других инструкциях

После того как **`TEST_PANEL_IP`** доступен в окружении (`source .env` или `export`), запускайте команды из [ADD_DOMOPHONE.md](ADD_DOMOPHONE.md) (привязка панели к адресу) в той же shell-сессии или с подгруженным `.env`.
