// POST /api/login — проверяет пароль админа и выдаёт токен на 12 часов.
// Лимит попыток (аудит безопасности, M1, N3): таблица login_attempts, миграции 005 и 007.
import { readBody, safeEqual, makeToken, supabase, telegram, clientIp, ipHash, countAttempt, ipAlertText } from "./_lib.js";

const WINDOW_MIN = 15;     // окно подсчёта попыток, минут
const LIMIT_PER_IP = 10;   // попыток с одного адреса за окно
const LIMIT_TOTAL = 100;   // попыток со всех адресов за окно — защита от перебора с многих IP
const KEEP_HOURS = 24;     // старые записи удаляются

const notify = (text) => telegram(text).catch((e) => console.error("Telegram:", e.message));

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Метод не поддерживается" });
  }
  res.setHeader("Cache-Control", "no-store");

  const { password } = readBody(req);
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return res.status(500).json({ error: "На сервере не задан ADMIN_PASSWORD" });

  const hash = ipHash("login", clientIp(req));

  // Как считаем — в countAttempt (_lib.js): параллельные запросы не проскочат лимит,
  // а один адрес не может закрыть вход для всех.
  let perIp, total, ipAlert;
  try {
    ({ perIp, total, ipAlert } = await countAttempt("login_attempts", hash, {
      windowMin: WINDOW_MIN, limitPerIp: LIMIT_PER_IP, limitTotal: LIMIT_TOTAL,
    }));
  } catch (e) {
    // Счётчик недоступен — вход закрыт, а не открыт без лимита
    console.error("login_attempts:", e.message);
    return res.status(503).json({ error: "Вход временно недоступен. Попробуйте через несколько минут." });
  }

  if (perIp > LIMIT_PER_IP || total > LIMIT_TOTAL) {
    // Оповещаем один раз — на первой заблокированной попытке, и не больше чем о 3 адресах за окно (аудит N4)
    if (ipAlert) {
      await notify(ipAlertText(`⚠️ Админка: ${LIMIT_PER_IP} попыток входа с одного адреса за ${WINDOW_MIN} минут. Адрес заблокирован на ${WINDOW_MIN} минут.`, ipAlert));
    } else if (total === LIMIT_TOTAL + 1) {
      await notify(`⚠️ Админка: ${LIMIT_TOTAL} попыток входа за ${WINDOW_MIN} минут с разных адресов. Похоже на подбор пароля. Вход закрыт на ${WINDOW_MIN} минут.`);
    }
    res.setHeader("Retry-After", String(WINDOW_MIN * 60));
    return res.status(429).json({ error: `Слишком много попыток входа. Подождите ${WINDOW_MIN} минут.` });
  }

  if (!password || !safeEqual(password, expected)) {
    // Небольшая пауза мешает подбирать пароль перебором
    await new Promise((r) => setTimeout(r, 800));
    return res.status(401).json({ error: "Неверный пароль" });
  }

  // Успешный вход: счётчик этого адреса обнуляется, заодно чистим старые записи.
  // Сбой уборки не мешает войти.
  const old = new Date(Date.now() - KEEP_HOURS * 3600e3).toISOString();
  await Promise.all([
    supabase(`login_attempts?ip_hash=eq.${hash}`, { method: "DELETE" }),
    supabase(`login_attempts?at=lt.${encodeURIComponent(old)}`, { method: "DELETE" }),
  ]).catch((e) => console.error("login_attempts cleanup:", e.message));

  return res.status(200).json({ token: makeToken() });
}
