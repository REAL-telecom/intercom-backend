## Добавление адреса в базу

Эта инструкция заполняет таблицу `addresses` (схема уже создаётся автоматически в `ensureSchema`).

### 1) Добавить адрес

В `.env` задайте переменные тестового адреса (без персональных данных):

```dotenv
TEST_ADDRESS_STREET=Testovaya
TEST_ADDRESS_HOUSE=1
TEST_ADDRESS_BUILDING=
TEST_ADDRESS_LETTER=
TEST_ADDRESS_STRUCTURE=
```

```bash
cd /opt/intercom-backend
set -a && source .env && set +a

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
)
RETURNING id, street, house, building, letter, structure;
"
```

### 2) Проверить запись

```bash
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
SELECT id, street, house, building, letter, structure, created_at, updated_at
FROM addresses
ORDER BY id DESC
LIMIT 10;
"
```

Сохраните `id` нужной записи — он нужен для привязки панели в `ADD_DOMOPHONE.md` и пользователя к адресу.
