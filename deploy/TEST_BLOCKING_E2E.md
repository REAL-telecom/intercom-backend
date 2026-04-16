## E2E тест блокировок (клиент + API/Redis + fail2ban)

Цель: подтвердить, что блокировки срабатывают на всех уровнях:
- клиентский UX-лок по `blockExpiresAt` (429) и `nextRequestAvailableAt` (200 request-code);
- прикладные лимиты backend (Redis);
- сетевой бан через fail2ban backend jail.

Перед тестом убедитесь, что backend запущен и `/health` отвечает.

### 1) Подготовка

На локальной машине определить внешний IP:

```bash
curl -4 ifconfig.me
```

Серверные проверки (по SSH):

```bash
ssh root@${SERVER_IP}
sudo fail2ban-client status auth-requests
sudo fail2ban-client status auth-verify
sudo fail2ban-client status auth-combined
sudo fail2ban-client status auth-combined | rg "<YOUR_IP>" || echo "IP не забанен"
```

Если IP уже забанен — разбанить:

```bash
sudo fail2ban-client set auth-requests unbanip <YOUR_IP>
sudo fail2ban-client set auth-verify unbanip <YOUR_IP>
sudo fail2ban-client set auth-combined unbanip <YOUR_IP>
sudo fail2ban-client status auth-combined | rg "<YOUR_IP>" || echo "IP удален из бана"
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
for i in {1..6}; do
  echo "request attempt $i"
  curl -sS -X POST "http://127.0.0.1:3000/auth/request-code" \
    -H "content-type: application/json" \
    -d '{"phone":"70000000000"}'
  echo
done
```

Ожидаемо:
- первые попытки: `success: true` (accepted/queued),
- 6-я: `success: false`, `message`, `blockExpiresAt`, HTTP `429`.

### 3) Проверка клиентских/Redis лимитов verify-code (порог 5, блок на 6-й)

На одном устройстве:
1. Запросить код для `71111111111`.
2. Ввести 5 раз неверный PIN.
3. На 6-й неверной попытке получить `429` + `blockExpiresAt`.
4. Экран verify должен блокировать повторные попытки по таймеру.

Проверка API напрямую:

```bash
for i in {1..6}; do
  echo "verify attempt $i"
  curl -sS -X POST "http://127.0.0.1:3000/auth/verify-code" \
    -H "content-type: application/json" \
    -d '{"phone":"71111111111","code":"00000"}'
  echo
done
```

Ожидаемо:
- до достижения лимита: `400` (wrong code),
- на блоке: `429` с `blockExpiresAt`.

### 4) Проверка fail2ban auth-requests jail (request-сценарий, порог 10)

Сгенерировать серию запросов с одного IP (лучше по разным номерам, чтобы не упереться только в клиентскую блокировку):

```bash
for i in {0..11}; do
  phone="79$(printf '%09d' "$i")"
  curl -sS -X POST "http://127.0.0.1:3000/auth/request-code" \
    -H "content-type: application/json" \
    -d "{\"phone\":\"$phone\"}" >/dev/null
done
```

Проверить на сервере:

```bash
ssh root@${SERVER_IP} "sudo fail2ban-client status auth-requests"
ssh root@${SERVER_IP} "sudo fail2ban-client status auth-requests | rg '<YOUR_IP>'"
```

Ожидаемо: IP появился в бан-листе `auth-requests` jail.

### 5) Разбан и повторная проверка fail2ban (verify-сценарий, порог 15)

Разбан:

```bash
ssh root@${SERVER_IP} "sudo fail2ban-client set auth-requests unbanip <YOUR_IP>"
ssh root@${SERVER_IP} "sudo fail2ban-client set auth-verify unbanip <YOUR_IP>"
ssh root@${SERVER_IP} "sudo fail2ban-client set auth-combined unbanip <YOUR_IP>"
```

Сделать 15+ неверных verify-запросов:

```bash
for i in {1..16}; do
  curl -sS -X POST "http://127.0.0.1:3000/auth/verify-code" \
    -H "content-type: application/json" \
    -d '{"phone":"72222222222","code":"00000"}' >/dev/null
done
```

Проверить бан:

```bash
ssh root@${SERVER_IP} "sudo fail2ban-client status auth-verify | rg '<YOUR_IP>'"
```

Ожидаемо: IP снова в бане в `auth-verify`.

### 6) Проверка суммарного jail auth-combined (request + verify, порог 12)

Смешать запросы request-code и verify-code, чтобы пересечь суммарный порог:

```bash
for i in {0..9}; do
  phone="78$(printf '%09d' "$i")"
  curl -sS -X POST "http://127.0.0.1:3000/auth/request-code" \
    -H "content-type: application/json" \
    -d "{\"phone\":\"$phone\"}" >/dev/null
done

for i in {1..11}; do
  curl -sS -X POST "http://127.0.0.1:3000/auth/verify-code" \
    -H "content-type: application/json" \
    -d '{"phone":"72222222222","code":"00000"}' >/dev/null
done
```

Проверить бан:

```bash
ssh root@${SERVER_IP} "sudo fail2ban-client status auth-combined | rg '<YOUR_IP>'"
```

Ожидаемо: IP появляется в `auth-combined` (суммарный) jail.

### 7) Критерии успешного прохождения

- Клиент показывает таймеры блокировок по `blockExpiresAt` (429) и кулдаун повторного запроса кода по `nextRequestAvailableAt` (200).
- Backend возвращает корректные `429` + `blockExpiresAt` на прикладных лимитах.
- fail2ban (`auth-requests`, `auth-verify`, `auth-combined`) банит IP на порогах `10/15/12` бессрочно (до ручного unban).
- После разбана запросы снова доходят до backend.
