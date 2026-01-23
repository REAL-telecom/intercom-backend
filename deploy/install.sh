#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"
CONFIG_DIR="${ROOT_DIR}/configs"
LOG_DIR="/opt/intercom-backend"
LOG_FILE="${LOG_DIR}/install.log"

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
  echo ""
  echo -e "${COLOR_BLUE}== $1 ==${COLOR_RESET}"
  log_line "== $1 =="
}

ok() {
  echo -e "${COLOR_GREEN}OK: $1${COLOR_RESET}"
  log_line "OK: $1"
}

warn() {
  echo -e "${COLOR_YELLOW}WARN: $1${COLOR_RESET}"
  log_line "WARN: $1"
}

err() {
  echo -e "${COLOR_RED}ERROR: $1${COLOR_RESET}"
  log_line "ERROR: $1"
}

check_output_installed() {
  local label="$1"
  local value="$2"
  if [[ -n "${value}" ]]; then
    echo "OK: ${label} ${value} установлен"
  else
    warn "Ошибка установки ${label}. Смотри лог: ${LOG_FILE}"
  fi
}

run_with_spinner() {
  local label="$1"
  local cmd="$2"
  local spinner='|/-\'
  local i=0
  local out="/dev/null"

  if [[ -t 1 ]]; then
    out="/dev/tty"
  fi

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

if [[ ! -f "${ENV_FILE}" ]]; then
  err "Файл .env не найден. Скопируйте env.example -> .env и заполните его."
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
run_with_spinner "apt-get update" "apt-get update -y"
run_with_spinner "apt-get install системные пакеты" "apt-get install -y certbot coturn fail2ban ufw wget ca-certificates curl gnupg"
policy_output="$(apt-cache policy ufw fail2ban certbot coturn)"
echo "${policy_output}" | sed -n '1,120p'
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
  warn "Системные зависимости установлены не полностью. Смотри лог: ${LOG_FILE}"
fi

section "Установка Node.js (LTS 24.x)"
run_with_spinner "NodeSource setup" "curl -fsSL https://deb.nodesource.com/setup_24.x | bash -"
run_with_spinner "Установка Node.js" "apt-get install -y nodejs"
node_version="$(node -v 2>/dev/null || true)"
npm_version="$(npm -v 2>/dev/null || true)"
check_output_installed "Node.js" "${node_version}"
check_output_installed "npm" "${npm_version}"

section "Обновление npm"
run_with_spinner "Обновление npm" "npm install -g npm@latest"
npm_version="$(npm -v 2>/dev/null || true)"
check_output_installed "npm" "${npm_version}"

section "Настройка firewall (ufw)"
ufw allow ssh
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 8089/tcp
ufw allow 10000:20000/udp
ufw allow 3478/udp
ufw allow 3478/tcp
ufw allow 5349/udp
ufw allow 5349/tcp
ufw --force enable
ufw status verbose
if ufw status verbose | grep -qi 'Status: active' \
  && ufw status verbose | grep -qE '(^|\\s)22/tcp\\b' \
  && ufw status verbose | grep -qE '(^|\\s)80/tcp\\b' \
  && ufw status verbose | grep -qE '(^|\\s)443/tcp\\b' \
  && ufw status verbose | grep -qE '(^|\\s)8089/tcp\\b' \
  && ufw status verbose | grep -qE '(^|\\s)10000:20000/udp\\b' \
  && ufw status verbose | grep -qE '(^|\\s)3478/udp\\b' \
  && ufw status verbose | grep -qE '(^|\\s)3478/tcp\\b' \
  && ufw status verbose | grep -qE '(^|\\s)5349/udp\\b' \
  && ufw status verbose | grep -qE '(^|\\s)5349/tcp\\b'; then
  ok "Firewall настроен"
else
  warn "Firewall не настроен. Смотри лог: ${LOG_FILE}"
fi

section "Установка Docker"
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
run_with_spinner "apt-get update (docker)" "apt-get update -y"
run_with_spinner "Установка Docker пакетов" "apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin"
docker_version="$(docker --version 2>/dev/null || true)"
compose_version="$(docker compose version 2>/dev/null || true)"
check_output_installed "Docker" "${docker_version}"
check_output_installed "Docker Compose" "${compose_version}"

section "Запуск Docker"
systemctl enable docker
systemctl start docker
check_service "docker"

section "Авторизация в Docker Hub"
login_output="$(echo "${DOCKER_PASSWORD}" | docker login -u "${DOCKER_USER}" --password-stdin 2>&1)"
echo "${login_output}"
if echo "${login_output}" | grep -qi "Login Succeeded"; then
  ok "Успешно"
else
  warn "Ошибка авторизации. Смотри лог: ${LOG_FILE}"
fi

section "Установка Asterisk"
cd /usr/src
run_with_spinner "Скачивание Asterisk" "wget -q http://downloads.asterisk.org/pub/telephony/asterisk/asterisk-22-current.tar.gz"
run_with_spinner "Распаковка Asterisk" "tar xvf asterisk-22-current.tar.gz"
cd asterisk-22.*
run_with_spinner "Asterisk prereq" "./contrib/scripts/install_prereq install"
run_with_spinner "Asterisk configure" "./configure --with-jansson-bundled"
run_with_spinner "Asterisk menuselect" "make menuselect/menuselect && make menuselect-tree && ./menuselect/menuselect --enable codec_opus --enable res_config_pgsql --disable CORE-SOUNDS-EN-GSM --enable CORE-SOUNDS-EN-WAV --enable CORE-SOUNDS-RU-WAV --enable MOH-OPSOUND-WAV"
run_with_spinner "Asterisk build/install" "make -j \"\$(nproc)\" && make install"
asterisk_version="$(/usr/sbin/asterisk -V 2>/dev/null || true)"
check_output_installed "Asterisk" "${asterisk_version}"

section "Создание пользователя asterisk"
if ! id asterisk >/dev/null 2>&1; then
  groupadd asterisk
  useradd -r -d /var/lib/asterisk -g asterisk asterisk
fi

mkdir -p /var/{lib,log,run,spool,cache}/asterisk
chown -R asterisk:asterisk /var/{lib,log,run,spool,cache}/asterisk
chown -R asterisk:asterisk /etc/asterisk
user_info="$(id asterisk 2>/dev/null || true)"
dirs_info="$(ls -ld /var/{lib,log,run,spool,cache}/asterisk /etc/asterisk 2>/dev/null || true)"
echo "${user_info}"
echo "${dirs_info}"
if [[ -n "${user_info}" ]] && echo "${dirs_info}" | grep -q 'asterisk'; then
  ok "Пользователь создан и права настроены"
else
  warn "Ошибка создания пользователя и настройки прав. Смотри лог: ${LOG_FILE}"
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
ls -la /etc/asterisk | sed -n '1,120p'
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

section "Настройка Coturn"
cp "${CONFIG_DIR}/coturn/turnserver.conf" /etc/turnserver.conf
sed -i "s/__SERVER_IP__/${SERVER_IP}/g" /etc/turnserver.conf
sed -i "s/__SERVER_DOMAIN__/${SERVER_DOMAIN}/g" /etc/turnserver.conf
sed -i "s/__TURN_USER__/${TURN_USER}/g" /etc/turnserver.conf
sed -i "s/__TURN_PASSWORD__/${TURN_PASSWORD}/g" /etc/turnserver.conf

systemctl enable coturn
systemctl start coturn
systemctl status coturn --no-pager | sed -n '1,20p'
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

section "Настройка Logrotate для Asterisk"
mkdir -p /etc/logrotate.d
cp "${CONFIG_DIR}/logrotate/asterisk" /etc/logrotate.d/asterisk
cat /etc/logrotate.d/asterisk
if [[ -s /etc/logrotate.d/asterisk ]] \
  && grep -q "daily" /etc/logrotate.d/asterisk \
  && grep -q "rotate 7" /etc/logrotate.d/asterisk \
  && grep -q "/var/log/asterisk/messages" /etc/logrotate.d/asterisk; then
  ok "Logrotate для Asterisk настроен"
else
  warn "Ошибка настройки Logrotate для Asterisk. Смотри лог: ${LOG_FILE}"
fi

section "Установка сервиса Asterisk"
cp "${CONFIG_DIR}/asterisk/asterisk.service" /etc/systemd/system/asterisk.service
systemctl daemon-reload
systemctl enable asterisk
systemctl start asterisk
if [[ -s /etc/systemd/system/asterisk.service ]] \
  && systemctl is-active --quiet asterisk; then
  ok "Asterisk запущен"
else
  warn "Asterisk не запущен. Смотри лог: ${LOG_FILE}"
fi

section "Настройка fail2ban"
mkdir -p /etc/fail2ban/filter.d
cp "${CONFIG_DIR}/fail2ban/jail.local" /etc/fail2ban/jail.local
cp "${CONFIG_DIR}/fail2ban/filter.d/asterisk.conf" /etc/fail2ban/filter.d/asterisk.conf
systemctl enable fail2ban
systemctl restart fail2ban
if [[ -s /etc/fail2ban/jail.local ]] \
  && [[ -s /etc/fail2ban/filter.d/asterisk.conf ]] \
  && systemctl is-active --quiet fail2ban; then
  ok "fail2ban настроен"
else
  warn "fail2ban не настроен. Смотри лог: ${LOG_FILE}"
fi
fail2ban-client status || true

section "Запуск Redis и Postgres через Docker Compose"
cd "${ROOT_DIR}"
run_with_spinner "docker compose up" "docker compose up -d"
docker compose ps
if docker compose ps --services --filter status=running | grep -q '^redis$' \
  && docker compose ps --services --filter status=running | grep -q '^postgres$'; then
  ok "Redis и Postgres запущены"
else
  warn "Redis и Postgres не запущены. Смотри лог: ${LOG_FILE}"
fi

section "Установка и запуск сервера"
mkdir -p /opt/intercom-backend
rsync -a --delete "${ROOT_DIR}/" /opt/intercom-backend/

cd /opt/intercom-backend
run_with_spinner "npm install (backend)" "npm install"
run_with_spinner "npm run build (backend)" "npm run build"

cp /opt/intercom-backend/configs/backend/intercom-backend.service /etc/systemd/system/intercom-backend.service
systemctl daemon-reload
systemctl enable intercom-backend
systemctl start intercom-backend
if systemctl is-active --quiet intercom-backend; then
  ok "Сервис запущен"
else
  warn "Сервис не запущен. Смотри лог: ${LOG_FILE}"
fi

echo "Проверка доступности сервера"
health_output="$(curl -fsS "http://127.0.0.1:${APP_PORT:-3000}/health" 2>/dev/null || true)"
if [[ -n "${health_output}" ]]; then
  ok "Сервер доступен"
else
  warn "Сервер недоступен. Смотри лог: ${LOG_FILE}"
fi

section "Завершение установки"
echo "Удаление неиспользуемых зависимостей и следов установок ..."
apt-get -y autoremove
apt-get -y autoclean
apt-get -y clean

echo "Удаление исходников Asterisk..."
rm -rf /usr/src/asterisk-22.* /usr/src/asterisk-22-current.tar.gz
if ls /usr/src/asterisk-22.* >/dev/null 2>&1 || ls /usr/src/asterisk-22-current.tar.gz >/dev/null 2>&1; then
  warn "Исходники Asterisk не удалены. Смотри лог: ${LOG_FILE}"
else
  ok "Исходники Asterisk удалены"
fi

echo "Удаление репозитория установки..."
log_line "Удаление репозитория установки..."
cd "${ROOT_DIR}/.."
rm -rf "${ROOT_DIR}"
if [[ -d "${ROOT_DIR}" ]]; then
  warn "Репозиторий не удален. Смотри лог: ${LOG_FILE}"
else
  ok "Репозиторий удален"
fi
ok "Установка завершена"
