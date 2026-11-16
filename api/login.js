// POST /api/login — проверяет пароль админа и выдаёт токен на 12 часов.
// Лимит попыток (аудит безопасности, M1): таблица login_attempts, миграция 005.
import { readBody, safeEqual, makeToken, supabase, telegram, clientIp, ipHash } from "./_lib.js";

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
  const since = new Date(Date.now() - WINDOW_MIN * 60e3).toISOString();

  // Сначала записываем попытку, потом считаем. Так параллельные запросы не проскочат лимит:
  // каждый следующий видит все записи, сделанные до него.
  // Читаем на 2 строки больше лимита: «лимит + 1» — первая заблокированная попытка (уведомление),
  // «лимит + 2» — все следующие (без уведомления).
  let perIp, total;
  try {
    await supabase("login_attempts", { method: "POST", body: { ip_hash: hash }, prefer: "return=minimal" });
    [perIp, total] = await Promise.all([
      supabase(`login_attempts?select=id&ip_hash=eq.${hash}&at=gte.${encodeURIComponent(since)}&limit=${LIMIT_PER_IP + 2}`),
      supabase(`login_attempts?select=id&at=gte.${encodeURIComponent(since)}&limit=${LIMIT_TOTAL + 2}`),
    ]);
  } catch (e) {
    // Счётчик недоступен — вход закрыт, а не открыт без лимита
    console.error("login_attempts:", e.message);
    return res.status(503).json({ error: "Вход временно недоступен. Попробуйте через несколько минут." });
  }

  if (perIp.length > LIMIT_PER_IP || total.length > LIMIT_TOTAL) {
    // Оповещаем один раз — на первой заблокированной попытке
    if (perIp.length === LIMIT_PER_IP + 1) {
      await notify(`⚠️ Админка: ${LIMIT_PER_IP} попыток входа с одного адреса за ${WINDOW_MIN} минут. Адрес заблокирован на ${WINDOW_MIN} минут.`);
    } else if (total.length === LIMIT_TOTAL + 1) {
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
