# Получение EXPO_ACCESS_TOKEN

Для работы Expo Push Service рекомендуется использовать токен доступа (опционально, но повышает надежность). Ниже способы его получения.

## Вариант 1: Через веб-интерфейс Expo (предпочтительно)

1. Откройте https://expo.dev
2. Войдите в аккаунт
3. Перейдите в Account Settings → Access Tokens
4. Создайте новый токен
5. Скопируйте токен в `.env` файл

## Вариант 2: Через Expo CLI

1. Установите Expo CLI глобально:
   ```bash
   npm install -g expo-cli
   ```

2. Войдите в аккаунт Expo:
   ```bash
   expo login
   ```
   Введите email и пароль от аккаунта Expo.

3. Проверьте текущего пользователя:
   ```bash
   expo whoami
   ```

4. Для получения access token используйте Expo API:
   - Запрос к `https://expo.io/--/api/v2/auth/login` с credentials
   - В ответе будет `accessToken`

## Вариант 3: Через EAS CLI

1. Установите EAS CLI:
   ```bash
   npm install -g eas-cli
   ```

2. Войдите:
   ```bash
   eas login
   ```

3. Проверьте пользователя:
   ```bash
   eas whoami
   ```

## Важно

Для Expo Push Service токен может быть необязателен, если отправляете push без авторизации (но лимиты доставки будут ниже).

Если используете токен, добавьте его в `.env`:
```
EXPO_ACCESS_TOKEN=ваш_токен_здесь
```
