## Добавление адреса в базу

Переменные берутся из `.env` (секция **TEST ADDRESS**).

### 1) Перейти в каталог и загрузить окружение

```bash
cd /opt/intercom-backend
set -a && source .env && set +a
```

### 2) Добавить адрес

```bash
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
INSERT INTO addresses (street, house, building, letter, structure, created_at, updated_at)
VALUES (
  '${TEST_ADDRESS_STREET}',
  '${TEST_ADDRESS_HOUSE}',
  NULLIF('${TEST_ADDRESS_BUILDING}', ''),
  NULLIF('${TEST_ADDRESS_LETTER}', ''),
  NULLIF('${TEST_ADDRESS_STRUCTURE}', ''),
  NOW(),
  NOW()
);
"
```

### 3) Проверить запись

```bash
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
SELECT id, street, house, building, letter, structure, created_at, updated_at
FROM addresses
ORDER BY id DESC
LIMIT 10;
"
```

Сохраните полученный `id` и добавьте его в `.env` как `TEST_PANEL_ADDRESS_ID` и `TEST_USER_ADDRESS_ID`.
