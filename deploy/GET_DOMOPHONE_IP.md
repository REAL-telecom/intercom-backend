## Получение IP домофона после регистрации

Эта инструкция помогает получить текущий IP зарегистрированной панели в Asterisk и сохранить его в переменную `PANEL_IP` для использования в `ADD_DOMOPHONE.md`.

### 1) Проверить контакты в Asterisk

```bash
sudo asterisk -rx "pjsip show contacts"
```

Найдите строку контакта нужной панели (например `Aor: domophone`). В адресе будет вид `sip:domophone@X.X.X.X:PORT`.

### 2) Извлечь IP и сохранить в переменную сессии

Вставьте найденный IP:

```bash
export PANEL_IP="X.X.X.X"
echo "$PANEL_IP"
```

### 3) Быстрая проверка

```bash
test -n "$PANEL_IP" && echo "PANEL_IP=$PANEL_IP"
```

Если переменная пустая — повторите шаг 1.

### 4) Использование в других инструкциях

После `export PANEL_IP=...` запускайте команды из `ADD_DOMOPHONE.md` в той же shell-сессии: там используется `$PANEL_IP`.
