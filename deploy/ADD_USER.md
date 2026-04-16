## Привязка существующего пользователя к адресу и квартире

Эта инструкция **не создаёт** пользователя.  
Пользователь уже должен существовать после OTP-верификации (`/auth/verify-code`).

Параметры задаются в **`.env`**, секция **TEST USER** в [`.env.example`](../.env.example).

### 1) Проверить, что пользователь есть

```bash
cd /opt/intercom-backend
set -a && source .env && set +a

docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
SELECT id, phone, address_id, apartment, created_at, updated_at, last_verified_at
FROM users
WHERE phone = '${TEST_USER_PHONE}';
"
```

Если строка не найдена — сначала пройдите OTP-верификацию в приложении.

### 2) Привязать пользователя к адресу и квартире

В `.env` задайте параметры пользователя для привязки:

```dotenv
TEST_USER_PHONE=79000000000
TEST_USER_ADDRESS_ID=1
TEST_USER_APARTMENT=1
```

```bash
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
UPDATE users
SET address_id = ${TEST_USER_ADDRESS_ID},
    apartment = '${TEST_USER_APARTMENT}',
    updated_at = NOW()
WHERE phone = '${TEST_USER_PHONE}';
"
```

### 3) Проверить результат

```bash
cd /opt/intercom-backend
set -a && source .env && set +a

docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
SELECT id, phone, address_id, apartment, created_at, updated_at, last_verified_at
FROM users
WHERE phone = '${TEST_USER_PHONE}';
"
```

Ожидается, что `address_id` и `apartment` заполнены.
