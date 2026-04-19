## Привязка существующего пользователя к адресу и квартире

Переменные берутся из `.env` (секция **TEST USER**).

Пользователь уже должен существовать после OTP-верификации через приложение (`/auth/verify-code`).

### 1) Перейти в каталог и загрузить окружение

```bash
cd /opt/intercom-backend
set -a && source .env && set +a
```

### 2) Проверить, что пользователь есть

```bash
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
SELECT id, phone, address_id, apartment, created_at, updated_at, last_verified_at
FROM users
WHERE phone = '${TEST_USER_PHONE}';
"
```

Если строка не найдена — сначала пройдите OTP-верификацию в приложении.

### 3) Привязать пользователя к адресу и квартире

```bash
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
UPDATE users
SET address_id = ${TEST_USER_ADDRESS_ID},
    apartment = '${TEST_USER_APARTMENT}',
    updated_at = NOW()
WHERE phone = '${TEST_USER_PHONE}';
"
```

### 4) Проверить результат

```bash
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
SELECT id, phone, address_id, apartment, created_at, updated_at, last_verified_at
FROM users
WHERE phone = '${TEST_USER_PHONE}';
"
```

Ожидается, что `address_id` и `apartment` заполнены.
