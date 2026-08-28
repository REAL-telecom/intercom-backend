## Смена домена на уже развёрнутом сервере

Инструкция для работающего стека (после [install.sh](install.sh)). С нуля сервер не переустанавливаем.

Шаблоны в репозитории (`configs/asterisk/http.conf`, `configs/coturn/turnserver.conf`) содержат плейсхолдер `__SERVER_DOMAIN__`. Их **не менять** — иначе сломается установка. Правим только уже заполненные файлы на сервере и `SERVER_DOMAIN` в `.env`.

PJSIP/Asterisk, МультиФон и панели домофона ходят по IP. Их трогать не нужно.

Подставьте значения и загрузите окружение:

```bash
OLD_DOMAIN=domophone.site
NEW_DOMAIN=domophone.su

cd /opt/intercom-backend
set -a && source .env && set +a
```

### 1) DNS

A-запись `NEW_DOMAIN` → тот же `SERVER_IP`, что в `.env`.

Проверка с рабочей машины (не с агента):

```bash
dig +short A "${NEW_DOMAIN}"
```

Должен вернуться `SERVER_IP`. Пинг не обязателен: ICMP на сервере может быть закрыт.

### 2) Сертификат Let's Encrypt

Порт 80 должен быть свободен (`certbot --standalone`). Сертификат выпускаем **до** смены `SERVER_DOMAIN`: бэкенд берёт cert/key из `/etc/letsencrypt/live/${SERVER_DOMAIN}/`.

```bash
certbot certonly --standalone --non-interactive --agree-tos \
  --email "admin@${NEW_DOMAIN}" -d "${NEW_DOMAIN}"
```

Ожидается:

- `/etc/letsencrypt/live/${NEW_DOMAIN}/fullchain.pem`
- `/etc/letsencrypt/live/${NEW_DOMAIN}/privkey.pem`

```bash
certbot certificates
```

### 3) Файлы на сервере

**`/opt/intercom-backend/.env`** (и локальная копия `.env` в репозитории, если она используется как образец):

```
SERVER_DOMAIN=<NEW_DOMAIN>
```

Было: `SERVER_DOMAIN=<OLD_DOMAIN>`.

От этой переменной зависят HTTPS бэкенда, SIP-домен в пушах и пути к сертификату.

**`/etc/asterisk/http.conf`** — две строки:

```
tlscertfile=/etc/letsencrypt/live/<NEW_DOMAIN>/fullchain.pem
tlsprivatekey=/etc/letsencrypt/live/<NEW_DOMAIN>/privkey.pem
```

**`/etc/turnserver.conf`** — три строки:

```
realm=<NEW_DOMAIN>
cert=/etc/letsencrypt/live/<NEW_DOMAIN>/fullchain.pem
pkey=/etc/letsencrypt/live/<NEW_DOMAIN>/privkey.pem
```

Замена одной командой (после проверки, что в файлах нет других вхождений старого домена, кроме этих путей/realm):

```bash
sed -i "s/${OLD_DOMAIN}/${NEW_DOMAIN}/g" \
  /opt/intercom-backend/.env \
  /etc/asterisk/http.conf \
  /etc/turnserver.conf
grep -n "${NEW_DOMAIN}\|${OLD_DOMAIN}" \
  /opt/intercom-backend/.env \
  /etc/asterisk/http.conf \
  /etc/turnserver.conf
```

В `.env` должно остаться одно `SERVER_DOMAIN=${NEW_DOMAIN}`. Старого домена в этих трёх файлах быть не должно.

### 4) Перезапуск

```bash
systemctl restart asterisk
systemctl restart coturn
systemctl restart intercom-backend
systemctl is-active asterisk coturn intercom-backend
```

Все три — `active`.

### 5) Проверка

```bash
curl -sI "https://${NEW_DOMAIN}:3000/health"
echo | openssl s_client -connect 127.0.0.1:3000 -servername "${NEW_DOMAIN}" 2>/dev/null \
  | openssl x509 -noout -subject -dates
```

Ожидается HTTP `200` и `CN = ${NEW_DOMAIN}`.

### 6) Старый сертификат

Когда новый домен отвечает по HTTPS, старый серт можно удалить:

```bash
certbot delete --cert-name "${OLD_DOMAIN}" --non-interactive
certbot certificates
```

Должен остаться только `${NEW_DOMAIN}`.

### 7) Клиентские репозитории

Дефолтный URL API зашит в приложениях. Порт тот же: `3000`.

**real**

- `src/config/api.ts` — `https://<NEW_DOMAIN>:3000`
- `.env.example` — комментарий и пример `EXPO_PUBLIC_BACKEND_URL` на новый домен

**expo-linphone** (example, не прод-приложение; по желанию)

- `example/src/config/backend.ts` — тот же URL
- `example/src/components/login/index.tsx` — хардкод `domain: '<NEW_DOMAIN>'`

Код `intercom-backend` домен не содержит: только `.env` и живые конфиги из шага 3.

### 8) Уже установленное приложение

URL бэкенда пишется в нативный стор и **не перезаписывается**, если значение уже есть (`getBackendUrl` / SharedPreferences, UserDefaults).

Переустановка apk поверх старой сборки стор не чистит. Нужно **удалить приложение** и поставить заново, иначе клиент продолжит ходить на старый домен.
