// POST /api/lead — принимает заявку с сайта, сохраняет в Supabase и пишет владельцу в Telegram.
// Запись в историю этапов («создана → Новая») делает триггер в базе.
// Лимит заявок (аудит безопасности, M2): таблица lead_attempts, миграция 006.
import { supabase, telegram, escapeHtml, readBody, clean, phoneOk, clientIp, ipHash } from "./_lib.js";

const WINDOW_MIN = 60;     // окно подсчёта отправок, минут
const LIMIT_PER_IP = 5;    // заявок с одного адреса за окно
const LIMIT_TOTAL = 30;    // заявок со всех адресов за окно — защита от спама с многих IP
const KEEP_HOURS = 24;     // старые записи удаляются
const REPEAT_MIN = 30;     // повторная заявка с тем же телефоном сохраняется, но без уведомления

const notify = (text) => telegram(text).catch((e) => console.error("Telegram:", e.message));

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Метод не поддерживается" });
  }
  res.setHeader("Cache-Control", "no-store");

  const body = readBody(req);

  // Скрытое поле-ловушка: люди его не видят, а боты заполняют
  if (body.website) return res.status(200).json({ ok: true });

  // Лимит считаем до проверки полей: пустые и кривые запросы тоже нагружают сервер.
  // Сначала записываем отправку, потом считаем — так параллельные запросы не проскочат лимит.
  const hash = ipHash("lead", clientIp(req));
  const since = new Date(Date.now() - WINDOW_MIN * 60e3).toISOString();
  let perIp, total;
  try {
    await supabase("lead_attempts", { method: "POST", body: { ip_hash: hash }, prefer: "return=minimal" });
    [perIp, total] = await Promise.all([
      supabase(`lead_attempts?select=id&ip_hash=eq.${hash}&at=gte.${encodeURIComponent(since)}&limit=${LIMIT_PER_IP + 2}`),
      supabase(`lead_attempts?select=id&at=gte.${encodeURIComponent(since)}&limit=${LIMIT_TOTAL + 2}`),
    ]);
  } catch (e) {
    // Счётчик недоступен — форма закрыта, а не открыта без лимита
    console.error("lead_attempts:", e.message);
    return res.status(503).json({ error: "Форма временно не работает. Попробуй ещё раз чуть позже." });
  }

  if (perIp.length > LIMIT_PER_IP || total.length > LIMIT_TOTAL) {
    // Оповещаем один раз — на первой заблокированной отправке
    if (perIp.length === LIMIT_PER_IP + 1) {
      await notify(`⚠️ Форма заявки: ${LIMIT_PER_IP} заявок с одного адреса за ${WINDOW_MIN} минут. Адрес заблокирован на час.`);
    } else if (total.length === LIMIT_TOTAL + 1) {
      await notify(`⚠️ Форма заявки: ${LIMIT_TOTAL} заявок за ${WINDOW_MIN} минут с разных адресов. Похоже на спам. Форма закрыта на час, проверьте воронку.`);
    }
    res.setHeader("Retry-After", String(WINDOW_MIN * 60));
    return res.status(429).json({ error: "Слишком много заявок подряд. Попробуй через час." });
  }

  const name = clean(body.name, 80);
  const phone = clean(body.phone, 40);
  const topic = clean(body.topic, 40);
  const comment = clean(body.comment, 1000);
  const ageNum = parseInt(body.age, 10);
  const age = ageNum >= 5 && ageNum <= 120 ? ageNum : null;

  if (!name && !phone) return res.status(400).json({ error: "Форма пустая. Напиши имя и телефон." });
  if (!name) return res.status(400).json({ error: "Напиши, как к тебе обращаться." });
  if (!phoneOk(phone)) {
    return res.status(400).json({ error: "Проверь номер телефона: в нём должно быть хотя бы 6 цифр." });
  }

  // Была ли заявка с этим телефоном за последние REPEAT_MIN минут. Если да — не шлём второе уведомление.
  // Сбой проверки не мешает: тогда уведомление уходит как обычно.
  const repeatSince = new Date(Date.now() - REPEAT_MIN * 60e3).toISOString();
  const repeat = await supabase(
    `leads?select=id&phone=eq.${encodeURIComponent(phone)}&created_at=gte.${encodeURIComponent(repeatSince)}&limit=1`
  ).then((rows) => rows.length > 0, () => false);

  let lead;
  try {
    [lead] = await supabase("leads", {
      method: "POST",
      // Заявка с сайта всегда попадает в воронку на этап «Новая» с источником «Сайт»
      body: { name, phone, age, topic, comment, source: "Сайт", status: "Новая" },
      prefer: "return=representation",
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Не получилось сохранить заявку. Попробуй ещё раз чуть позже." });
  }

  // Старые записи счётчика удаляем. Сбой уборки не мешает заявке.
  const old = new Date(Date.now() - KEEP_HOURS * 3600e3).toISOString();
  await supabase(`lead_attempts?at=lt.${encodeURIComponent(old)}`, { method: "DELETE" })
    .catch((e) => console.error("lead_attempts cleanup:", e.message));

  // Повтор с тем же телефоном — заявка в воронке есть, второе уведомление не шлём
  if (repeat) return res.status(201).json({ ok: true, id: lead.id });

  // Заявка уже сохранена, поэтому сбой Telegram не должен ломать ответ посетителю
  try {
    const when = new Date(lead.created_at).toLocaleString("ru-RU", { timeZone: "Europe/Chisinau" });
    const lines = [
      `<b>Новая заявка #${lead.id}</b>`,
      `Имя: ${escapeHtml(name)}`,
      `Телефон: ${escapeHtml(phone)}`,
      age ? `Возраст: ${age}` : null,
      topic ? `Нужно: ${escapeHtml(topic)}` : null,
      comment ? `Комментарий: ${escapeHtml(comment)}` : null,
      `Время: ${when}`,
    ].filter(Boolean);
    await telegram(lines.join("\n"));
  } catch (err) {
    console.error(err);
  }

  return res.status(201).json({ ok: true, id: lead.id });
}
