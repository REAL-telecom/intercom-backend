# Патч драйвера PostgreSQL на уже собранном Asterisk

Патч `patches/asterisk-22.11.0-pgsql-store-skip-unknown-columns.patch` меняет `store_pgsql` в `res_config_pgsql.c` Asterisk 22.11.0. При вставке драйвер пропускает колонки, которых нет в таблице. Имя `100rel` без кавычек иначе ломает создание временной учётки. Это форк: при каждом обновлении Asterisk патч накладывается заново. Сначала сверить, не появился ли в новой версии пропуск колонок при вставке. [PR #2147](https://github.com/asterisk/asterisk/pull/2147) этого не заменяет: он только ставит кавычки вокруг `100rel` и по-прежнему пишет все поля. Обсуждение: [issue #1655](https://github.com/asterisk/asterisk/issues/1655).

Свежий `install.sh` накладывает патч сам, до `configure` и `make`. Если `/usr/sbin/asterisk` уже есть, сборка пропускается: модуль пересобирается по шагам ниже.

Исходники лежат в `/usr/src/asterisk-22.11.0`. Репозиторий на сервере — `/opt/intercom-backend`. Дерево должно быть уже сконфигурировано той сборкой, из которой стоит станция.

### 1) Остановить Asterisk

```bash
systemctl stop asterisk
```

### 2) Проверить, что патч ложится

```bash
cd /usr/src/asterisk-22.11.0
patch -p1 --dry-run < /opt/intercom-backend/deploy/patches/asterisk-22.11.0-pgsql-store-skip-unknown-columns.patch
```

Дерево при этом не меняется. Если проверка не прошла, патч не накладывать.

### 3) Наложить патч

```bash
patch -p1 < /opt/intercom-backend/deploy/patches/asterisk-22.11.0-pgsql-store-skip-unknown-columns.patch
```

Повторный запуск на уже изменённом дереве завершится ошибкой. Это значит, что патч уже наложен.

### 4) Сохранить текущий модуль

```bash
cp /usr/lib/asterisk/modules/res_config_pgsql.so /usr/lib/asterisk/modules/res_config_pgsql.so.bak
```

Откат без пересборки: вернуть `.bak` на место `res_config_pgsql.so` и запустить Asterisk.

### 5) Пересобрать и установить только модуль

```bash
cd /usr/src/asterisk-22.11.0
make res
cp res/res_config_pgsql.so /usr/lib/asterisk/modules/res_config_pgsql.so
```

Команда `make res/res_config_pgsql.so` модуль не собирает: в этом дереве у цели нет правила с нужными путями к заголовкам. `make res` из корня исходников собирает драйвер с теми же флагами, что и полная установка.

### 6) Запустить Asterisk и проверить модуль

```bash
systemctl start asterisk
asterisk -rx "module show like res_config_pgsql"
```

В списке модуль должен быть `Running`. Дальше контрольный звонок с панели: он создаёт временную учётку. В консоли не должно быть `trailing junk` и `column ... does not exist` на `ps_endpoints`. Отладку на станции для этой проверки не включать.
