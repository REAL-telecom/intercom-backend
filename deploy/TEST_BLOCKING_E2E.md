## E2E тест блокировок (клиент + API/Redis + fail2ban)

Документ для **ручной** проверки: в первую очередь **прикладные rate limits** по частоте запросов к `/auth/request-code` и `/auth/verify-code` (счётчики Redis, ответы **429**, поля **`blockExpiresAt`** / **`nextRequestAvailableAt`**), затем при необходимости — срабатывание fail2ban.

Цель: подтвердить, что блокировки срабатывают на всех уровнях:
- клиентский UX-лок по `blockExpiresAt` (429) и `nextRequestAvailableAt` (200 request-code);
- прикладные лимиты backend (Redis);
- сетевой бан через fail2ban (единый jail `auth`, см. [configs/fail2ban/README.md](../configs/fail2ban/README.md)).

Перед тестом убедитесь, что backend запущен и `/health` отвечает.

### 1) Подготовка

На локальной машине определить внешний IP:

```bash
curl -4 ifconfig.me
```

Серверные проверки (по SSH):

```bash
ssh root@${SERVER_IP}
sudo fail2ban-client status auth
sudo fail2ban-client status auth | rg "<YOUR_IP>" || echo "IP не забанен"
```

Если IP уже забанен — разбанить:

```bash
sudo fail2ban-client set auth unbanip <YOUR_IP>
sudo fail2ban-client status auth | rg "<YOUR_IP>" || echo "IP удален из бана"
```

Рекомендуемые тестовые номера:
- `70000000000`
- `71111111111`
- `72222222222`

### 2) Проверка клиентских/Redis лимитов request-code (порог 5, блок на 6-й)

На одном устройстве:
1. Открыть экран регистрации.
2. Сделать 5 запросов кода подряд для одного номера (например `70000000000`).
3. На 6-й попытке должен вернуться `429` и `blockExpiresAt`.
4. На клиенте кнопка запроса кода должна быть заблокирована до окончания таймера.

Проверка API напрямую (локальная машина):

```bash
for i in {1..5}; do
  echo "request attempt $i"
  curl -sS -X POST "http://127.0.0.1:3000/auth/request-code" \
    -H "content-type: application/json" \
    -d '{"phone":"70000000000"}'
  echo
done
```

Ожидаемо:
- первые попытки: `success: true` (accepted/queued),
- 5-я: `success: false`, `message`, `blockExpiresAt`, HTTP `429`.

### 3) Проверка клиентских/Redis лимитов verify-code (порог 5)

На одном устройстве:
1. Запросить код для `70000000000`.
2. Ввести 5 раз неверный PIN.
3. На 6-й неверной попытке получить `429` + `blockExpiresAt`.
4. Экран verify должен блокировать повторные попытки по таймеру.

Проверка API напрямую:

```bash
for i in {1..5}; do
  echo "verify attempt $i"
  curl -sS -X POST "http://127.0.0.1:3000/auth/verify-code" \
    -H "content-type: application/json" \
    -d '{"phone":"70000000000","code":"00000"}'
  echo
done
```

Ожидаемо:
- до лимита `400` (`Неверный код` / `Код устарел`);
- на блоке: `429` с `blockExpiresAt`.

### 4) Проверка fail2ban jail `auth` (request-сценарий, порог 10)

Сгенерировать серию запросов, чтобы backend начал писать `AUTH_BLOCK`:

```bash
for i in {0..15}; do
  phone="79$(printf '%09d' "$i")"
  curl -sS -X POST "http://127.0.0.1:3000/auth/request-code" \
    -H "content-type: application/json" \
    -d "{\"phone\":\"$phone\"}" >/dev/null
done
```

Проверить на сервере:

```bash
ssh root@${SERVER_IP} "sudo fail2ban-client status auth"
ssh root@${SERVER_IP} "sudo fail2ban-client status auth | rg '<YOUR_IP>'"
```

Ожидаемо: IP появляется в бан-листе jail `auth`.
(`auth.conf` ловит `AUTH_BLOCK`, а в `jail.local` для `auth` стоит `maxretry = 1`.)

### 5) Разбан и повторная проверка fail2ban jail `auth` (verify-сценарий, порог 10)

Разбан:

```bash
ssh root@${SERVER_IP} "sudo fail2ban-client set auth unbanip <YOUR_IP>"
ssh root@${SERVER_IP} "sudo fail2ban-client status auth | rg '<YOUR_IP>' || echo not banned"
```

Ожидаемо: после разбана запросы снова доходят до backend.

```bash
for i in {1..5}; do
  curl -sS -X POST "http://127.0.0.1:3000/auth/verify-code" \
    -H "content-type: application/json" \
    -d '{"phone":"70000000000","code":"00000"}' >/dev/null
done
```

- Клиент показывает таймеры по `blockExpiresAt` и кулдаун по `nextRequestAvailableAt`.
- Backend возвращает корректные `429` + `blockExpiresAt` на прикладных лимитах.
- fail2ban банит IP через единый jail `auth` по логам `AUTH_BLOCK`.
