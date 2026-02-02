#!/usr/bin/env bash
set -euo pipefail

ASTERISK_MAJOR="22"
ASTERISK_TARBALL="asterisk-${ASTERISK_MAJOR}-current.tar.gz"
CONFIG_DIR="${ROOT_DIR}/configs"
ENV_FILE="${ROOT_DIR}/.env"
FIREBASE_JSON_FILE=$(ls "${ROOT_DIR}"/*-firebase-adminsdk-*.json 2>/dev/null | head -n1) || true
LOG_DIR="/opt/intercom-backend"
LOG_FILE="${LOG_DIR}/install.log"
NPM_VERSION="11.8.0"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -t 1 ]]; then
  COLOR_BLUE="\033[34m"
  COLOR_GREEN="\033[32m"
  COLOR_YELLOW="\033[33m"
  COLOR_RED="\033[31m"
  COLOR_RESET="\033[0m"
else
  COLOR_BLUE=""
  COLOR_GREEN=""
  COLOR_YELLOW=""
  COLOR_RED=""
  COLOR_RESET=""
fi

CONSOLE_OUT="/dev/stderr"
if [[ -w /dev/tty ]]; then
  CONSOLE_OUT="/dev/tty"
fi

log_line() {
  printf "%s\n" "$1" >> "${LOG_FILE}"
}

check_service() {
  local service="$1"
  if systemctl is-active --quiet "${service}"; then
    ok "${service} активен"
  else
    warn "${service} не активен"
    systemctl status "${service}" --no-pager || true
  fi
}

section() {
  printf "\n" > "${CONSOLE_OUT}"
  printf "%b\n" "${COLOR_BLUE}== $1 ==${COLOR_RESET}" > "${CONSOLE_OUT}"
  log_line "== $1 =="
}

ok() {
  printf "%b\n" "${COLOR_GREEN}OK: $1${COLOR_RESET}" > "${CONSOLE_OUT}"
  log_line "OK: $1"
}

warn() {
  printf "%b\n" "${COLOR_YELLOW}WARN: $1${COLOR_RESET}" > "${CONSOLE_OUT}"
  log_line "WARN: $1"
}

err() {
  printf "%b\n" "${COLOR_RED}ERROR: $1${COLOR_RESET}" > "${CONSOLE_OUT}"
  log_line "ERROR: $1"
}

extract_version() {
  echo "$1" | grep -Eo '[0-9]+(\.[0-9]+)+' | head -n 1
}

check_output_installed() {
  local label="$1"
  local value="$2"
  if [[ -n "${value}" ]]; then
    ok "${label} версия ${value} установлен"
  else
    warn "Ошибка установки ${label}. Смотри лог: ${LOG_FILE}"
  fi
}

run_with_spinner() {
  local label="$1"
  local cmd="$2"
  local spinner='|/-\'
  local i=0
  local out="${CONSOLE_OUT}"

  log_line "RUN: ${label}"
  printf "%s ... " "${label}" > "${out}"

  bash -c "${cmd}" >> "${LOG_FILE}" 2>&1 &
  local pid=$!

  while kill -0 "${pid}" 2>/dev/null; do
    printf "\r%s ... %c" "${label}" "${spinner:i++%${#spinner}:1}" > "${out}"
    sleep 0.1
  done

  wait "${pid}"
  local status=$?
  if [[ ${status} -eq 0 ]]; then
    printf "\r%s ... done\n" "${label}" > "${out}"
  else
    printf "\r%s ... failed\n" "${label}" > "${out}"
  fi
  return ${status}
}

wait_for_apt_idle() {
  run_with_spinner "Ожидание завершения фоновых процессов ОС" \
    "while fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 || fuser /var/lib/dpkg/lock >/dev/null 2>&1; do sleep 2; done"
}

skip_if_done() {
  if "$@"; then
    ok "Пропуск (уже выполнено)"
    return 0
  fi
  return 1
}

if [[ ! -f "${ENV_FILE}" ]]; then
  err "Файл .env не найден. Скопируйте env.example -> .env и заполните его."
  exit 1
fi

if [[ -z "${FIREBASE_JSON_FILE}" ]] || [[ ! -f "${FIREBASE_JSON_FILE}" ]]; then
  err "Файл ключа Firebase (*-firebase-adminsdk-*.json) не найден. Скопируйте JSON в корень репозитория."
  exit 1
fi

mkdir -p "${LOG_DIR}"
exec > >(tee -a "${LOG_FILE}") 2>&1

set -a
source "${ENV_FILE}"
set +a

require_var() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "Отсутствует переменная: ${name}"
    exit 1
  fi
}

section "Установка сервера intercom"

section "Проверка переменных окружения"
require_var SERVER_DOMAIN
require_var SERVER_IP
require_var ARI_USER
require_var ARI_PASSWORD
require_var REDIS_PASSWORD
require_var TURN_USER
require_var TURN_PASSWORD
require_var POSTGRES_DB
require_var POSTGRES_USER
require_var POSTGRES_PASSWORD
require_var DOCKER_USER
require_var DOCKER_PASSWORD
ok "Переменные окружения найдены"

section "Обновление ОС и установка системных зависимостей"
if skip_if_done command -v certbot >/dev/null 2>&1 && command -v ufw >/dev/null 2>&1 && command -v turnserver >/dev/null 2>&1 && command -v fail2ban-client >/dev/null 2>&1; then
  :
else
wait_for_apt_idle
run_with_spinner "Поиск и установка обновлений" "apt-get update -y"
run_with_spinner "Установка certbot" "apt-get install -y certbot"
run_with_spinner "Установка coturn" "apt-get install -y coturn"
run_with_spinner "Установка fail2ban" "apt-get install -y fail2ban"
run_with_spinner "Установка ufw" "apt-get install -y ufw"
run_with_spinner "Установка wget" "apt-get install -y wget"
run_with_spinner "Установка ca-certificates" "apt-get install -y ca-certificates"
run_with_spinner "Установка curl" "apt-get install -y curl"
run_with_spinner "Установка gnupg" "apt-get install -y gnupg"
policy_output="$(apt-cache policy ufw fail2ban certbot coturn)"
echo "${policy_output}" | sed -n '1,120p' >> "${LOG_FILE}" 2>&1
if echo "${policy_output}" | awk '
  $1 ~ /:$/ { pkg=substr($1, 1, length($1)-1); installed=""; }
  $1 == "Installed:" { installed=$2; 
    if (pkg == "ufw" || pkg == "fail2ban" || pkg == "certbot" || pkg == "coturn") {
      if (installed == "(none)") { bad=1; }
    }
  }
  END { exit bad ? 1 : 0 }
'; then
  ok "Системные зависимости установлены"
else
  warn "Ошибка установки или обновления системных пакетов. Смотри лог: ${LOG_FILE}"
fi
fi

section "Настройка firewall (ufw)"
if skip_if_done sh -c 'ufw status 2>/dev/null | grep -q "Status: active"'; then
  :
else
ufw allow ssh >> "${LOG_FILE}" 2>&1
ufw allow 80/tcp >> "${LOG_FILE}" 2>&1
ufw allow 443/tcp >> "${LOG_FILE}" 2>&1
ufw allow 5060/udp >> "${LOG_FILE}" 2>&1
ufw allow 8089/tcp >> "${LOG_FILE}" 2>&1
ufw allow 10000:20000/udp >> "${LOG_FILE}" 2>&1
ufw allow 3000/udp >> "${LOG_FILE}" 2>&1
ufw allow 3000/tcp >> "${LOG_FILE}" 2>&1
ufw allow 3478/udp >> "${LOG_FILE}" 2>&1
ufw allow 3478/tcp >> "${LOG_FILE}" 2>&1
ufw allow 5349/udp >> "${LOG_FILE}" 2>&1
ufw allow 5349/tcp >> "${LOG_FILE}" 2>&1
ufw_enable_output="$(ufw --force enable 2>&1)"
ufw status verbose >> "${LOG_FILE}" 2>&1
echo "${ufw_enable_output}" >> "${LOG_FILE}" 2>&1
if echo "${ufw_enable_output}" | grep -q "Firewall is active and enabled on system startup"; then
  ok "Firewall настроен"
else
  warn "Firewall не настроен. Смотри лог: ${LOG_FILE}"
fi
fi

section "Получение SSL сертификатов Let's Encrypt"
if skip_if_done test -f "/etc/letsencrypt/live/${SERVER_DOMAIN}/fullchain.pem" -a -f "/etc/letsencrypt/live/${SERVER_DOMAIN}/privkey.pem"; then
  :
else
run_with_spinner "Получение сертификата для ${SERVER_DOMAIN}" "sleep 5 && certbot certonly --standalone --non-interactive --agree-tos --email admin@${SERVER_DOMAIN} -d ${SERVER_DOMAIN}"

if [[ -d "/etc/letsencrypt/live/${SERVER_DOMAIN}" ]] && [[ -f "/etc/letsencrypt/live/${SERVER_DOMAIN}/fullchain.pem" ]] && [[ -f "/etc/letsencrypt/live/${SERVER_DOMAIN}/privkey.pem" ]]; then
  ok "SSL сертификаты успешно получены для ${SERVER_DOMAIN}"
else
  warn "Не удалось получить SSL сертификаты. Смотри лог: ${LOG_FILE}"
fi
fi

section "Настройка автоматического обновления сертификатов"
if skip_if_done systemctl is-enabled --quiet certbot.timer 2>/dev/null && test -x /etc/letsencrypt/renewal-hooks/deploy/reload-services.sh 2>/dev/null; then
  :
else
# Создаем директорию для хуков обновления
mkdir -p /etc/letsencrypt/renewal-hooks/deploy

# Проверяем, что таймер certbot активен
systemctl enable certbot.timer >> "${LOG_FILE}" 2>&1
systemctl start certbot.timer >> "${LOG_FILE}" 2>&1
if systemctl is-active --quiet certbot.timer || systemctl is-enabled --quiet certbot.timer; then
  ok "Таймер автоматического обновления сертификатов настроен"
else
  warn "Таймер certbot не активен. Смотри лог: ${LOG_FILE}"
fi

# Копируем скрипт для перезагрузки сервисов после обновления сертификатов
# Certbot автоматически выполняет все исполняемые скрипты из renewal-hooks/deploy/
# при успешном обновлении сертификатов (не требуется указывать --deploy-hook)
if [[ -f "${CONFIG_DIR}/tools/reload-services.sh" ]]; then
  cp "${CONFIG_DIR}/tools/reload-services.sh" /etc/letsencrypt/renewal-hooks/deploy/reload-services.sh
  chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-services.sh
  
  # Проверяем, что файл успешно скопирован и исполняемый
  if [[ -f /etc/letsencrypt/renewal-hooks/deploy/reload-services.sh ]] && [[ -x /etc/letsencrypt/renewal-hooks/deploy/reload-services.sh ]]; then
    ok "Скрипт перезагрузки сервисов установлен"
  else
    warn "Ошибка установки скрипта перезагрузки сервисов. Смотри лог: ${LOG_FILE}"
  fi
else
  warn "Скрипт reload-services.sh не найден в репозитории (configs/tools). Смотри лог: ${LOG_FILE}"
fi
fi

section "Установка Asterisk"
if skip_if_done test -x /usr/sbin/asterisk; then
  :
else
cd /usr/src
run_with_spinner "Скачивание дистрибутива" "wget -q http://downloads.asterisk.org/pub/telephony/asterisk/${ASTERISK_TARBALL}"
run_with_spinner "Распаковка дистрибутива" "tar xvf ${ASTERISK_TARBALL}"
cd asterisk-${ASTERISK_MAJOR}.*
wait_for_apt_idle
run_with_spinner "Установка зависимостей" "./contrib/scripts/install_prereq install"
run_with_spinner "Конфигурирование компонентов" "./configure --with-jansson-bundled"
run_with_spinner "Подключение компонентов" "make menuselect/menuselect && make menuselect-tree && ./menuselect/menuselect --enable codec_opus --enable res_config_pgsql --disable CORE-SOUNDS-EN-GSM --enable CORE-SOUNDS-EN-WAV --enable CORE-SOUNDS-RU-WAV --enable MOH-OPSOUND-WAV"
run_with_spinner "Сборка и установка программы" "make -j \"\$(nproc)\" && make install"
asterisk_version="$(/usr/sbin/asterisk -V 2>/dev/null || true)"
asterisk_version_clean="$(extract_version "${asterisk_version}")"
check_output_installed "Asterisk" "${asterisk_version_clean}"
fi

section "Создание пользователя asterisk"
if skip_if_done id asterisk >/dev/null 2>&1; then
  :
else
if ! id asterisk >/dev/null 2>&1; then
  groupadd asterisk
  useradd -r -d /var/lib/asterisk -g asterisk asterisk
fi

mkdir -p /var/{lib,log,run,spool,cache}/asterisk
chown -R asterisk:asterisk /var/{lib,log,run,spool,cache}/asterisk
chown -R asterisk:asterisk /etc/asterisk
user_info="$(id asterisk 2>/dev/null || true)"
dirs_info="$(ls -ld /var/{lib,log,run,spool,cache}/asterisk /etc/asterisk 2>/dev/null || true)"
echo "${user_info}" >> "${LOG_FILE}" 2>&1
echo "${dirs_info}" >> "${LOG_FILE}" 2>&1
if [[ -n "${user_info}" ]] && echo "${dirs_info}" | grep -q 'asterisk'; then
  ok "Пользователь создан и права настроены"
else
  warn "Ошибка создания пользователя и настройки прав. Смотри лог: ${LOG_FILE}"
fi
fi

section "Копирование файлов конфигураций Asterisk"
mkdir -p /etc/asterisk
cp "${CONFIG_DIR}/asterisk/"*.conf /etc/asterisk/

sed -i "s/__SERVER_IP__/${SERVER_IP}/g" /etc/asterisk/rtp.conf
sed -i "s/__SERVER_DOMAIN__/${SERVER_DOMAIN}/g" /etc/asterisk/http.conf
sed -i "s/__SERVER_DOMAIN__/${SERVER_DOMAIN}/g" /etc/asterisk/pjsip.conf
sed -i "s/__ARI_USER__/${ARI_USER}/g" /etc/asterisk/ari.conf
sed -i "s/__ARI_PASSWORD__/${ARI_PASSWORD}/g" /etc/asterisk/ari.conf
sed -i "s/__POSTGRES_DB__/${POSTGRES_DB}/g" /etc/asterisk/res_pgsql.conf
sed -i "s/__POSTGRES_USER__/${POSTGRES_USER}/g" /etc/asterisk/res_pgsql.conf
sed -i "s/__POSTGRES_PASSWORD__/${POSTGRES_PASSWORD}/g" /etc/asterisk/res_pgsql.conf
ls -la /etc/asterisk | sed -n '1,120p' >> "${LOG_FILE}" 2>&1
if [[ -s /etc/asterisk/ari.conf ]] \
  && [[ -s /etc/asterisk/http.conf ]] \
  && [[ -s /etc/asterisk/pjsip.conf ]] \
  && [[ -s /etc/asterisk/rtp.conf ]] \
  && [[ -s /etc/asterisk/res_pgsql.conf ]] \
  && ! grep -q '__SERVER_IP__' /etc/asterisk/rtp.conf \
  && ! grep -q '__SERVER_DOMAIN__' /etc/asterisk/http.conf \
  && ! grep -q '__SERVER_DOMAIN__' /etc/asterisk/pjsip.conf \
  && ! grep -q '__ARI_USER__' /etc/asterisk/ari.conf \
  && ! grep -q '__ARI_PASSWORD__' /etc/asterisk/ari.conf; then
  ok "Файлы конфигураций успешно скопированы"
else
  warn "Ошибка копирования файлов конфигурации Asterisk. Смотри лог: ${LOG_FILE}"
fi

section "Установка утилиты управления Asterisk-логов"
if skip_if_done test -x /usr/local/bin/asterisk-full-logs-on 2>/dev/null; then
  :
else
mkdir -p /usr/local/bin
if [[ -f "${CONFIG_DIR}/tools/asterisk-full-logs-on" ]] && [[ -f "${CONFIG_DIR}/tools/asterisk-full-logs-off" ]]; then
  cp "${CONFIG_DIR}/tools/asterisk-full-logs-on" /usr/local/bin/asterisk-full-logs-on
  cp "${CONFIG_DIR}/tools/asterisk-full-logs-off" /usr/local/bin/asterisk-full-logs-off
  chmod +x /usr/local/bin/asterisk-full-logs-on /usr/local/bin/asterisk-full-logs-off
  ok "Утилиты установлены: asterisk-full-logs-on/off"
else
  warn "Утилиты логов не найдены в репозитории (configs/tools). Смотри лог: ${LOG_FILE}"
fi
fi

section "Настройка Logrotate для Asterisk"
if skip_if_done test -s /etc/logrotate.d/asterisk 2>/dev/null; then
  :
else
mkdir -p /etc/logrotate.d
cp "${CONFIG_DIR}/logrotate/asterisk" /etc/logrotate.d/asterisk
cat /etc/logrotate.d/asterisk >> "${LOG_FILE}" 2>&1
if [[ -s /etc/logrotate.d/asterisk ]] \
  && grep -q "daily" /etc/logrotate.d/asterisk \
  && grep -q "rotate 7" /etc/logrotate.d/asterisk \
  && grep -q "/var/log/asterisk/messages" /etc/logrotate.d/asterisk; then
  ok "Logrotate для Asterisk настроен"
else
  warn "Ошибка настройки Logrotate для Asterisk. Смотри лог: ${LOG_FILE}"
fi
fi

section "Настройка Coturn"
if skip_if_done test -s /etc/turnserver.conf 2>/dev/null && ! grep -q '__SERVER_IP__' /etc/turnserver.conf 2>/dev/null && systemctl is-active --quiet coturn 2>/dev/null; then
  :
else
cp "${CONFIG_DIR}/coturn/turnserver.conf" /etc/turnserver.conf
sed -i "s/__SERVER_IP__/${SERVER_IP}/g" /etc/turnserver.conf
sed -i "s/__SERVER_DOMAIN__/${SERVER_DOMAIN}/g" /etc/turnserver.conf
sed -i "s/__TURN_USER__/${TURN_USER}/g" /etc/turnserver.conf
sed -i "s/__TURN_PASSWORD__/${TURN_PASSWORD}/g" /etc/turnserver.conf

systemctl enable coturn >> "${LOG_FILE}" 2>&1
systemctl start coturn
systemctl status coturn --no-pager | sed -n '1,20p' >> "${LOG_FILE}" 2>&1
if [[ -s /etc/turnserver.conf ]] \
  && ! grep -q '__SERVER_IP__' /etc/turnserver.conf \
  && ! grep -q '__SERVER_DOMAIN__' /etc/turnserver.conf \
  && ! grep -q '__TURN_USER__' /etc/turnserver.conf \
  && ! grep -q '__TURN_PASSWORD__' /etc/turnserver.conf \
  && systemctl is-active --quiet coturn; then
  ok "Coturn настроен и запущен"
else
  warn "Coturn не настроен. Смотри лог: ${LOG_FILE}"
fi
fi

section "Установка Docker и Docker Compose"
if skip_if_done sh -c 'command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 && ( test -f /lib/systemd/system/docker.service || test -f /usr/lib/systemd/system/docker.service )'; then
  :
else
wait_for_apt_idle
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
run_with_spinner "Скачивание дистрибутива" "apt-get update -y"
run_with_spinner "Установка" "apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin"
docker_version="$(docker --version 2>/dev/null || true)"
compose_version="$(docker compose version 2>/dev/null || true)"
docker_version_clean="$(extract_version "${docker_version}")"
compose_version_clean="$(extract_version "${compose_version}")"
check_output_installed "Docker" "${docker_version_clean}"
check_output_installed "Docker Compose" "${compose_version_clean}"
fi

section "Запуск Docker"
if skip_if_done systemctl is-active --quiet docker 2>/dev/null; then
  :
else
systemctl enable docker >> "${LOG_FILE}" 2>&1
systemctl start docker >> "${LOG_FILE}" 2>&1
check_service "docker"
fi

DOCKER_IMAGES_EXIST=0
if docker image inspect redis:7-alpine >/dev/null 2>&1 && docker image inspect postgres:18-alpine >/dev/null 2>&1; then
  DOCKER_IMAGES_EXIST=1
fi

section "Авторизация в Docker Hub"
if [[ "${DOCKER_IMAGES_EXIST}" -eq 1 ]]; then
  ok "Пропуск (уже выполнено)"
else
  login_output="$(echo "${DOCKER_PASSWORD}" | docker login -u "${DOCKER_USER}" --password-stdin 2>&1)"
  echo "${login_output}" >> "${LOG_FILE}" 2>&1
  if echo "${login_output}" | grep -qi "Login Succeeded"; then
    ok "Login Succeeded"
  else
    err "${login_output}"
  fi
fi

section "Скачивание образов Redis и Postgres"
if [[ "${DOCKER_IMAGES_EXIST}" -eq 1 ]]; then
  ok "Пропуск (уже выполнено)"
else
  cd "${ROOT_DIR}"
  run_with_spinner "docker compose pull" "docker compose pull"
  cd - >/dev/null
  ok "Образы скачаны"
fi

section "Запуск Redis и Postgres через Docker Compose"
if skip_if_done sh -c "cd \"${ROOT_DIR}\" && docker compose ps --services --filter status=running 2>/dev/null | grep -q '^redis$' && docker compose ps --services --filter status=running 2>/dev/null | grep -q '^postgres$'"; then
  :
else
  cd "${ROOT_DIR}"
  run_with_spinner "docker compose up" "docker compose up -d"
  docker compose ps >> "${LOG_FILE}" 2>&1
  if docker compose ps --services --filter status=running | grep -q '^redis$' \
    && docker compose ps --services --filter status=running | grep -q '^postgres$'; then
    ok "Redis и Postgres запущены"
  else
    warn "Redis и Postgres не запущены. Смотри лог: ${LOG_FILE}"
  fi
  cd - >/dev/null
fi

section "Запуск сервиса Asterisk"
if skip_if_done systemctl is-active --quiet asterisk 2>/dev/null; then
  :
else
cp "${CONFIG_DIR}/asterisk/asterisk.service" /etc/systemd/system/asterisk.service
systemctl daemon-reload
systemctl enable asterisk >> "${LOG_FILE}" 2>&1
systemctl start asterisk >> "${LOG_FILE}" 2>&1
if [[ -s /etc/systemd/system/asterisk.service ]] \
  && systemctl is-active --quiet asterisk; then
  ok "Asterisk запущен"
else
  warn "Asterisk не запущен. Смотри лог: ${LOG_FILE}"
fi
fi

section "Настройка fail2ban"
if skip_if_done test -s /etc/fail2ban/jail.local 2>/dev/null && systemctl is-active --quiet fail2ban 2>/dev/null; then
  :
else
mkdir -p /etc/fail2ban/filter.d
cp "${CONFIG_DIR}/fail2ban/jail.local" /etc/fail2ban/jail.local
cp "${CONFIG_DIR}/fail2ban/filter.d/asterisk.conf" /etc/fail2ban/filter.d/asterisk.conf
systemctl enable fail2ban >> "${LOG_FILE}" 2>&1
systemctl restart fail2ban >> "${LOG_FILE}" 2>&1
if [[ -s /etc/fail2ban/jail.local ]] \
  && [[ -s /etc/fail2ban/filter.d/asterisk.conf ]] \
  && systemctl is-active --quiet fail2ban; then
  ok "fail2ban настроен"
else
  warn "fail2ban не настроен. Смотри лог: ${LOG_FILE}"
fi
fail2ban-client status >> "${LOG_FILE}" 2>&1 || true
fi

section "Установка Node.js (LTS 24.x)"
if skip_if_done command -v node >/dev/null 2>&1; then
  :
else
wait_for_apt_idle
run_with_spinner "Скачивание дистрибутива" "curl -fsSL https://deb.nodesource.com/setup_24.x | bash -"
run_with_spinner "Установка" "apt-get install -y nodejs"
node_version="$(node -v 2>/dev/null || true)"
node_version_clean="$(extract_version "${node_version}")"
check_output_installed "Node.js" "${node_version_clean}"
fi

section "Обновление npm"
if skip_if_done test "$(extract_version "$(npm -v 2>/dev/null || true)")" = "${NPM_VERSION}"; then
  :
else
  run_with_spinner "Обновление npm" "npm install -g npm@${NPM_VERSION}"
  npm_version="$(npm -v 2>/dev/null || true)"
  npm_version_clean="$(extract_version "${npm_version}")"
  check_output_installed "npm" "${npm_version_clean}"
fi

section "Установка сервера intercom-backend"
if skip_if_done test -f /opt/intercom-backend/package.json; then
  :
else
  mkdir -p /opt/intercom-backend
  rsync -a --delete --exclude 'install.log' "${ROOT_DIR}/" /opt/intercom-backend/
  cd /opt/intercom-backend
  run_with_spinner "Скачивание и установка зависимостей" "npm install"
  run_with_spinner "Сборка" "npm run build"
  cp /opt/intercom-backend/configs/backend/intercom-backend.service /etc/systemd/system/intercom-backend.service
  systemctl daemon-reload
  systemctl enable intercom-backend >> "${LOG_FILE}" 2>&1
  ok "Сервер установлен"
fi

BACKEND_RUNNING=0
section "Запуск сервера intercom-backend"
if skip_if_done systemctl is-active --quiet intercom-backend 2>/dev/null; then
  BACKEND_RUNNING=1
else
  run_with_spinner "Запуск сервера" "systemctl start intercom-backend"
  if systemctl is-active --quiet intercom-backend; then
    ok "Сервис запущен"
    BACKEND_RUNNING=1
  else
    warn "Сервис не запущен. Смотри лог: ${LOG_FILE}"
  fi
fi

# Проверка доступности только если сервис запущен
if [[ "${BACKEND_RUNNING}" -eq 1 ]]; then
  section "Проверка доступности сервера"
  if [[ -f "/etc/letsencrypt/live/${SERVER_DOMAIN}/fullchain.pem" ]] && [[ -f "/etc/letsencrypt/live/${SERVER_DOMAIN}/privkey.pem" ]]; then
    health_url="https://127.0.0.1:${APP_PORT:-3000}/health"
    health_opts="-fsSk"
  else
    health_url="http://127.0.0.1:${APP_PORT:-3000}/health"
    health_opts="-fsS"
  fi
  health_ok=0
  run_with_spinner "Проверка доступности сервера" "sleep 2; for i in 1 2 3 4 5 6 7 8 9 10; do if curl ${health_opts} '${health_url}' >/dev/null 2>&1; then exit 0; fi; sleep 1; done; exit 1" || health_ok=1
  if [[ ${health_ok} -eq 0 ]]; then
    ok "Сервер доступен"
  else
    warn "Сервер недоступен. Смотри лог: ${LOG_FILE}"
  fi
fi

section "Завершение установки"
wait_for_apt_idle
echo "Удаление неиспользуемых зависимостей и следов установок ..."
apt-get -y autoremove >> "${LOG_FILE}" 2>&1
apt-get -y clean >> "${LOG_FILE}" 2>&1
cleanup_ok=1

echo "Удаление исходников Asterisk..."
rm -rf "/usr/src/asterisk-${ASTERISK_MAJOR}.*" "/usr/src/${ASTERISK_TARBALL}"
if ls "/usr/src/asterisk-${ASTERISK_MAJOR}.*" >/dev/null 2>&1 || ls "/usr/src/${ASTERISK_TARBALL}" >/dev/null 2>&1; then
  src_ok=0
else
  src_ok=1
fi

echo "Удаление репозитория установки..."
log_line "Удаление репозитория установки..."
cd "${ROOT_DIR}/.."
rm -rf "${ROOT_DIR}"
if [[ -d "${ROOT_DIR}" ]]; then
  repo_ok=0
else
  repo_ok=1
fi
if [[ ${cleanup_ok} -eq 1 && ${src_ok} -eq 1 && ${repo_ok} -eq 1 ]]; then
  ok "Установка завершена"
else
  warn "Установка завершена с предупреждениями. Смотри лог: ${LOG_FILE}"
fi
