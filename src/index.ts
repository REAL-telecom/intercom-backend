import Fastify from "fastify";
import sensible from "@fastify/sensible";
import fs from "fs";
import { env } from "./config";
import { createDatabaseSchema, seedEndpointTemplates } from "./store/postgres";
import { registerAuthRoutes } from "./routes/auth";
import { registerPushRoutes } from "./routes/push";
import { registerCallRoutes } from "./routes/calls";
import { websocket } from "./ari";
import { cleanupStaleChannels } from "./calls/channels/watchdog";
import { checkPendingOriginate } from "./calls/dial";
import { handleAriEvent } from "./calls/events/dispatcher";
import { cancelAllEndpointRemovals, cleanupStaleEndpoints } from "./calls/endpoints";
import { startOtpDialer } from "./otp/dialer";

// Пути к сертификатам Let's Encrypt:
//  - fullchain.pem — цепочка публичных ключей,
//  - privkey.pem — приватный ключ домена.
// Если файлов нет, сервис работает по HTTP.
const certPath = `/etc/letsencrypt/live/${env.serverDomain}/fullchain.pem`;
const keyPath = `/etc/letsencrypt/live/${env.serverDomain}/privkey.pem`;
const hasCertificates = fs.existsSync(certPath) && fs.existsSync(keyPath);

// Опции HTTPS для Fastify. Сертификаты читаются синхронно при старте.
// Если чтение упало, например файл битый или нет доступа, работаем по HTTP:
// сервис должен подняться, а не уйти в цикл перезапуска.
// Здесь console.warn, а не app.log: логгер Fastify ещё не создан.
let httpsOptions: { cert: Buffer; key: Buffer } | undefined;
if (hasCertificates) {
  try {
    httpsOptions = {
      cert: fs.readFileSync(certPath),
      key: fs.readFileSync(keyPath),
    };
  } catch (error) {
    console.warn("Failed to read SSL certificates, falling back to HTTP", error);
  }
}

// Создаёт экземпляр Fastify. Это конструктор сервера, а не запуск:
// порт начнёт слушаться только на app.listen. До этого на экземпляр
// навешиваются плагины и маршруты.
//
// Опции:
//  - logger — встроенный логгер, доступен как app.log
//  - https — добавляется, только если сертификаты прочитаны. Иначе Fastify работает по HTTP.
const app = Fastify({
  logger: { level: env.logLevel },
  ...(httpsOptions ? { https: httpsOptions } : {}),
});

// Подключает плагин @fastify/sensible. Он добавляет хелперы HTTP-ответов,
// например app.httpErrors.badRequest и reply.notFound. Без него этих методов нет.
app.register(sensible);

/**
 * STALE_ENDPOINT_CLEANUP_MS — задаёт интервал дворника учёток телефона.
 * После событийного снятия он страховка, не основной уборщик.
 */
const STALE_ENDPOINT_CLEANUP_MS = 10 * 60 * 1000;

/**
 * STALE_CHANNEL_CLEANUP_MS — задаёт интервал проверки просроченных каналов.
 */
const STALE_CHANNEL_CLEANUP_MS = 60_000;

/**
 * PENDING_ORIGINATE_CHECK_MS — задаёт интервал опроса ожидающих дозвона.
 */
const PENDING_ORIGINATE_CHECK_MS = 2_000;

let isCleaningStaleEndpoints = false;
let isCleaningStaleChannels = false;
let isCheckingPendingOriginate = false;

/**
 * start — запускает сервер по порядку: база, маршруты, воркер, таймеры, ARI, приём запросов.
 * Ошибка базы или listen завершает процесс: без базы сервер принимать запросы не должен.
 */
async function start(): Promise<void> {
  // База раньше остального: без таблиц маршруты и дворники падают на первом обращении.
  try {
    await createDatabaseSchema();
    await seedEndpointTemplates();
  } catch (error) {
    app.log.error({ err: error }, "Failed to ensure database schema");
    process.exit(1);
  }

  // Маршруты:
  //  - /auth/* — регистрация телефона и подтверждение кода,
  //  - /push/register — привязка push-токена,
  //  - /calls/end — завершение звонка.
  await registerAuthRoutes(app);
  await registerPushRoutes(app);
  await registerCallRoutes(app);

  // Воркер OTP — бесконечный цикл чтения очереди Redis. Ждать его нельзя.
  // Ошибка логируется и не роняет сервер: падение воркера не должно убивать обработку звонков.
  void startOtpDialer(app).catch((error) => {
    app.log.error({ err: error }, "OTP dialer stopped unexpectedly");
  });

  // Таймеры после базы. Опрос дозвона идёт раз в 2 секунды и читает Postgres.
  const staleEndpointsTimer = setInterval(() => {
    if (isCleaningStaleEndpoints) {
      app.log.debug("Cleanup: skipping stale endpoints, previous pass still running");
      return;
    }
    isCleaningStaleEndpoints = true;
    cleanupStaleEndpoints(app)
      .catch((error) => {
        app.log.error({ err: error }, "Cleanup: failed to cleanup stale endpoints");
      })
      .finally(() => {
        isCleaningStaleEndpoints = false;
      });
  }, STALE_ENDPOINT_CLEANUP_MS);

  const overdueChannelsTimer = setInterval(() => {
    if (isCleaningStaleChannels) {
      app.log.debug("Cleanup: skipping overdue channels, previous pass still running");
      return;
    }
    isCleaningStaleChannels = true;
    cleanupStaleChannels(app)
      .catch((error) => {
        app.log.error({ err: error }, "Cleanup: failed to hang up overdue channels");
      })
      .finally(() => {
        isCleaningStaleChannels = false;
      });
  }, STALE_CHANNEL_CLEANUP_MS);

  // Опрос ожидающих дозвона: читает Postgres, зовёт checkPendingOriginate по каждой учётке телефона.
  const pendingOriginateTimer = setInterval(() => {
    if (isCheckingPendingOriginate) {
      app.log.debug("Skipping pending originate check, previous pass still running");
      return;
    }
    isCheckingPendingOriginate = true;
    checkPendingOriginate(app)
      .catch((error) => {
        app.log.error({ err: error }, "Failed to check pending originate");
      })
      .finally(() => {
        isCheckingPendingOriginate = false;
      });
  }, PENDING_ORIGINATE_CHECK_MS);

  app.addHook("onClose", async () => {
    clearInterval(staleEndpointsTimer);
    clearInterval(overdueChannelsTimer);
    clearInterval(pendingOriginateTimer);
    cancelAllEndpointRemovals();
  });

  function shutdown() {
    void app.close();
  }
  
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  // Сокет ARI после базы: первые события сразу читают Redis и Postgres.
  app.log.info("Connecting to ARI WebSocket");
  websocket((event) => handleAriEvent(event, app), app.log);

  const protocol = httpsOptions ? "https" : "http";
  app.log.info({ protocol, port: env.appPort, hasCertificates }, "Starting server");
  await app.listen({ port: env.appPort, host: "0.0.0.0" });
}

void start().catch((error) => {
  app.log.error({ err: error }, "Failed to start server");
  process.exit(1);
});
