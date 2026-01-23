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

if [[ $EUID -ne 0 ]]; then
  err "Недостаточно прав. Запустите команду от имени администратора: sudo ./deploy/install.sh"
  exit 1
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  err "Файл .env не найден. Скопируйте env.example -> .env и заполните."
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
ok "Переменные окружения найдены"

section "Обновление ОС и установка системных зависимостей"
apt-get update -y
apt-get install -y \
  certbot \
  coturn \
  fail2ban \
  iptables-persistent \
  ufw \
  wget \
  ca-certificates \
  curl \
  gnupg
ok "Системные зависимости установлены"

section "Установка Node.js (LTS 24.x)"
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs
ok "Node.js установлен"
section "Обновление npm до последней версии"
npm install -g npm@latest
ok "npm обновлен"

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
ok "Firewall настроен"

section "Установка Docker"
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
ok "Docker установлен"

section "Запуск Docker"
systemctl enable docker
systemctl start docker
ok "Docker запущен"

section "Установка Asterisk из исходников"
cd /usr/src
wget -q http://downloads.asterisk.org/pub/telephony/asterisk/asterisk-20-current.tar.gz
tar xvf asterisk-20-current.tar.gz
cd asterisk-20.*
./contrib/scripts/install_prereq install
./configure --with-jansson-bundled
make menuselect/menuselect
make menuselect-tree
./menuselect/menuselect \
  --enable codec_opus \
  --enable res_config_pgsql \
  --disable CORE-SOUNDS-EN-GSM \
  --enable CORE-SOUNDS-EN-WAV \
  --enable CORE-SOUNDS-RU-WAV \
  --enable MOH-OPSOUND-WAV
make -j "$(nproc)" && make install
ok "Asterisk установлен"
rm -rf /usr/src/asterisk-20.* /usr/src/asterisk-20-current.tar.gz
ok "Исходники Asterisk удалены"

section "Создание пользователя asterisk"
if ! id asterisk >/dev/null 2>&1; then
  groupadd asterisk
  useradd -r -d /var/lib/asterisk -g asterisk asterisk
fi

mkdir -p /var/{lib,log,run,spool,cache}/asterisk
chown -R asterisk:asterisk /var/{lib,log,run,spool,cache}/asterisk
chown -R asterisk:asterisk /etc/asterisk
ok "Пользователь и права настроены"

section "Копирование конфигураций Asterisk"
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
ok "Конфигурации Asterisk применены"

section "Настройка Coturn"
cp "${CONFIG_DIR}/coturn/turnserver.conf" /etc/turnserver.conf
sed -i "s/__SERVER_IP__/${SERVER_IP}/g" /etc/turnserver.conf
sed -i "s/__SERVER_DOMAIN__/${SERVER_DOMAIN}/g" /etc/turnserver.conf
sed -i "s/__TURN_USER__/${TURN_USER}/g" /etc/turnserver.conf
sed -i "s/__TURN_PASSWORD__/${TURN_PASSWORD}/g" /etc/turnserver.conf

systemctl enable coturn
systemctl start coturn
ok "Coturn настроен и запущен"

section "Настройка ротации логов Asterisk"
mkdir -p /etc/logrotate.d
cp "${CONFIG_DIR}/logrotate/asterisk" /etc/logrotate.d/asterisk
ok "Logrotate для Asterisk настроен"

section "Установка сервиса Asterisk"
cp "${CONFIG_DIR}/asterisk/asterisk.service" /etc/systemd/system/asterisk.service
systemctl daemon-reload
systemctl enable asterisk
systemctl start asterisk
ok "Asterisk запущен"

section "Настройка fail2ban"
mkdir -p /etc/fail2ban/filter.d
cp "${CONFIG_DIR}/fail2ban/jail.local" /etc/fail2ban/jail.local
cp "${CONFIG_DIR}/fail2ban/filter.d/asterisk.conf" /etc/fail2ban/filter.d/asterisk.conf
systemctl enable fail2ban
systemctl restart fail2ban
ok "fail2ban настроен"

section "Запуск Redis и Postgres через Docker Compose"
cd "${ROOT_DIR}"
docker compose up -d
ok "Redis и Postgres запущены"

section "Установка и запуск backend"
mkdir -p /opt/intercom-backend
rsync -a --delete "${ROOT_DIR}/" /opt/intercom-backend/

cd /opt/intercom-backend
npm install
npm run build

cp /opt/intercom-backend/configs/backend/intercom-backend.service /etc/systemd/system/intercom-backend.service
systemctl daemon-reload
systemctl enable intercom-backend
systemctl start intercom-backend
ok "Backend запущен"

section "Очистка пакетов"
apt-get -y autoremove
apt-get -y autoclean
apt-get -y clean
ok "Очистка завершена"

section "Готово"
echo "Удаляем репозиторий установки..."
log_line "Удаляем репозиторий установки..."
cd "${ROOT_DIR}/.."
rm -rf "${ROOT_DIR}"
ok "Репозиторий удален"
