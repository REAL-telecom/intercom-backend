# Intercom Backend

Этот репозиторий содержит серверную часть умной домофонии.

## Быстрый старт

### 1. Подготовка сервера

Склонируйте репозиторий:

   ```bash
   git clone https://github.com/REAL-telecom/intercom-backend
   cd intercom-backend
   ```
### 2. Настройка окружения

Создайте файл `.env` из шаблона и отредактируйте его:

   ```bash
   cp .env.example .env
   nano .env
   ```

   **Обязательные переменные:**
   
   - `SERVER_DOMAIN`, `SERVER_IP`
   - `ARI_USER`, `ARI_PASSWORD`
   - `DOCKER_USER`, `DOCKER_PASSWORD`
   - `FAIL2BAN_IGNOREIP`
   - `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`
   - `REDIS_PASSWORD`
   - `TURN_USER`, `TURN_PASSWORD`

   **Для рабочей системы также нужны:**

   - FIREBASE_SERVICE_ACCOUNT_PATH — push-уведомления
   - MULTIFON_PHONE, MULTIFON_PASSWORD — исходящие OTP-звонки

Полный список переменных — в [`.env.example`](.env.example)

   **Важно для рабочей системы:**
   - `FIREBASE_SERVICE_ACCOUNT_PATH` — без него не будет push (FCM).
   - `MULTIFON_PHONE`, `MULTIFON_PASSWORD` — без них не будет исходящего OTP-звонка.

   Полный перечень и комментарии по переменным — в [`.env.example`](.env.example).

### 3. Firebase ключ

Скопируйте файл ключа Firebase (`*-firebase-adminsdk-*.json`) в корень репозитория:

   ```bash
   scp ./*-firebase-adminsdk-*.json USER@SERVER:/путь/к/intercom-backend/
   ```

### 4. Установки 

Запустите скрипт установки:

   ```bash
   sudo ./deploy/install.sh
   ```

   **Опционально:** чтобы смотреть лог установки в реальном времени.
   Откройте второе окно терминала и выполните:
   ```bash
   tail -f /opt/intercom-backend/install.log
   ```

### 5. Проверка статуса

   ```bash
   systemctl status intercom-backend
   ```

## Установленные компоненты
   - Asterisk — SIP-сервер
   - Coturn — TURN/STUN сервер
   - Postgres + Redis — базы данных (запускаются через docker-compose)
   - Node.js backend — API и логика приложения

## Настройка после установки

Пошаговые инструкции:

- [Подключение SIP-транка (МультиФон)](deploy/ADD_MULTIFON.md)
- [Добавление адреса](deploy/ADD_ADDRESS.md)
- [Регистрация панели домофона](deploy/ADD_DOMOPHONE.md)
- [Привязка пользователя](deploy/ADD_USER.md)
