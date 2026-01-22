#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"
CONFIG_DIR="${ROOT_DIR}/configs"

if [[ $EUID -ne 0 ]]; then
  echo "Запускать от root: sudo ./deploy/install.sh"
  exit 1
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Файл .env не найден. Скопируйте env.example -> .env и заполните."
  exit 1
fi

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

echo "== Обновление ОС и установка зависимостей =="
apt-get update -y
apt-get install -y build-essential \
  certbot \
  coturn \
  iptables-persistent \
  libcurl4-openssl-dev \
  libedit-dev \
  libjansson-dev \
  libldap2-dev \
  liblzma-dev \
  libncurses-dev \
  libsqlite3-dev \
  libssl-dev \
  libsrtp2-dev \
  libsystemd-dev \
  libxml2-dev \
  libxslt1-dev \
  libpq-dev \
  pkg-config \
  uuid-dev \
  wget \
  ca-certificates \
  curl \
  gnupg \
  nodejs \
  npm

echo "== Установка Docker =="
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

echo "== Запуск Docker =="
systemctl enable docker
systemctl start docker

echo "== Установка Asterisk из исходников =="
cd /usr/src
wget -q http://downloads.asterisk.org/pub/telephony/asterisk/asterisk-20-current.tar.gz
tar xvf asterisk-20-current.tar.gz
cd asterisk-20.*
./configure --with-jansson-bundled
make menuselect/menuselect
make menuselect-tree
./menuselect/menuselect \
  --enable codec_opus \
  --disable CORE-SOUNDS-EN-GSM \
  --enable CORE-SOUNDS-EN-WAV \
  --enable CORE-SOUNDS-RU-WAV \
  --enable MOH-OPSOUND-WAV
make -j "$(nproc)" && make install

echo "== Создание пользователя asterisk =="
if ! id asterisk >/dev/null 2>&1; then
  groupadd asterisk
  useradd -r -d /var/lib/asterisk -g asterisk asterisk
fi

mkdir -p /var/{lib,log,run,spool}/asterisk
chown -R asterisk:asterisk /var/{lib,log,run,spool}/asterisk
chown -R asterisk:asterisk /etc/asterisk

echo "== Копирование конфигураций Asterisk =="
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

echo "== Настройка Coturn =="
cp "${CONFIG_DIR}/coturn/turnserver.conf" /etc/turnserver.conf
sed -i "s/__SERVER_IP__/${SERVER_IP}/g" /etc/turnserver.conf
sed -i "s/__SERVER_DOMAIN__/${SERVER_DOMAIN}/g" /etc/turnserver.conf
sed -i "s/__TURN_USER__/${TURN_USER}/g" /etc/turnserver.conf
sed -i "s/__TURN_PASSWORD__/${TURN_PASSWORD}/g" /etc/turnserver.conf

systemctl enable coturn
systemctl start coturn

echo "== Установка сервиса Asterisk =="
cp "${CONFIG_DIR}/asterisk/asterisk.service" /etc/systemd/system/asterisk.service
systemctl daemon-reload
systemctl enable asterisk
systemctl start asterisk

echo "== Запуск Redis и Postgres через Docker Compose =="
cd "${ROOT_DIR}"
docker compose up -d

echo "== Установка и запуск backend =="
mkdir -p /opt/intercom-backend
rsync -a --delete "${ROOT_DIR}/" /opt/intercom-backend/

cd /opt/intercom-backend
npm install
npm run build

cp /opt/intercom-backend/configs/backend/intercom-backend.service /etc/systemd/system/intercom-backend.service
systemctl daemon-reload
systemctl enable intercom-backend
systemctl start intercom-backend

echo "== Очистка пакетов =="
apt-get -y autoremove
apt-get -y autoclean
apt-get -y clean

echo "== Готово =="
echo "Удаляем репозиторий установки..."
cd /
rm -rf "${ROOT_DIR}"
