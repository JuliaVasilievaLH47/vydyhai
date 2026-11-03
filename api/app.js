// Telegram Mini App «Запись на консультацию» (страница app.html → /app).
//   GET  /api/app — темы, свободные слоты на 14 дней и активная запись пользователя, если она есть
//   POST /api/app — записаться: {topic, date: "ГГГГ-ММ-ДД", time: "ЧЧ:00", phone?, contact?}
// Доступ только с проверенным initData Telegram в заголовке "Authorization: tma <initData>", иначе 401.
// Имя, telegram_id и username берутся только из проверенного initData.
// Один файл на оба запроса: на бесплатном тарифе Vercel число функций ограничено.
import { supabase, telegram, escapeHtml, readBody, clean, phoneOk, telegramUser, verifyTelegramData } from "./_lib.js";

const TZ = "Europe/Chisinau";
// Темы — как в форме на сайте (index.html), без «Просто перезвонить»
const TOPICS = ["Врач", "Психолог", "Семинар"];
// Начало слотов по Кишинёву: консультация длится час, последняя заканчивается в 18:00. Все 7 дней недели.
const HOURS = [10, 11, 12, 13, 14, 15, 16, 17];
const DAYS_AHEAD = 14;               // сегодня + 13 дней
const MIN_LEAD_MS = 60 * 60 * 1000;  // записаться можно не позже чем за час до начала
const BOOKED = "Записан на консультацию";

// ---------- Время по Кишинёву ----------

function tzParts(ms) {
  const p = {};
  new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ms)).forEach((x) => { p[x.type] = x.value; });
  return p;
}

// "ГГГГ-ММ-ДД" + час по Кишинёву → момент времени (мс UTC). Учитывает летнее и зимнее время.
function chisinauToUtc(date, hour) {
  const [y, m, d] = date.split("-").map(Number);
  const target = Date.UTC(y, m - 1, d, hour);
  let ms = target;
  for (let i = 0; i < 2; i++) {
    const p = tzParts(ms);
    ms += target - Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  }
  return ms;
}

// Ближайшие 14 календарных дней по Кишинёву, начиная с сегодняшнего
function upcomingDays() {
  const p = tzParts(Date.now());
  const today = Date.UTC(+p.year, +p.month - 1, +p.day);
  return Array.from({ length: DAYS_AHEAD }, (_, i) => new Date(today + i * 86400000).toISOString().slice(0, 10));
}

const hhmm = (h) => `${String(h).padStart(2, "0")}:00`;
const formatWhen = (ms) => new Date(ms).toLocaleString("ru-RU", {
  timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
});

// Занятые слоты (как мс UTC) в диапазоне; клиенты на этапе «Отказ» время не занимают — как в индексе БД
async function busySlots(fromMs, toMs) {
  const rows = await supabase(
    `leads?select=consultation_at` +
    `&consultation_at=gte.${new Date(fromMs).toISOString()}&consultation_at=lt.${new Date(toMs).toISOString()}` +
    `&status=neq.${encodeURIComponent("Отказ")}`
  );
  return new Set(rows.map((r) => Date.parse(r.consultation_at)));
}

async function activeBooking(telegramId) {
  const [row] = await supabase(
    `leads?select=id,topic,consultation_at&telegram_id=eq.${telegramId}` +
    `&status=eq.${encodeURIComponent(BOOKED)}&consultation_at=not.is.null&limit=1`
  );
  return row ? { topic: row.topic, when: formatWhen(Date.parse(row.consultation_at)) } : null;
}

// Телефон: подписанный Telegram контакт из requestContact (если он про этого же пользователя) или ручной ввод
function pickPhone(body, user) {
  if (body.contact) {
    const signed = verifyTelegramData(String(body.contact), 3600);
    try {
      const contact = signed && JSON.parse(signed.contact);
      if (contact && Number(contact.user_id) === user.id && contact.phone_number) {
        const phone = clean(contact.phone_number, 40);
        return { phone: /^\d+$/.test(phone) ? "+" + phone : phone };
      }
    } catch { /* неподписанный или испорченный контакт просто игнорируем */ }
  }
  const phone = clean(body.phone, 40);
  if (phone && !phoneOk(phone)) return { error: "Проверь номер телефона: в нём должно быть хотя бы 6 цифр." };
  return { phone };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const user = telegramUser(req);
  if (!user) return res.status(401).json({ error: "Откройте приложение в Telegram." });

  try {
    if (req.method === "GET") {
      const days = upcomingDays();
      const busy = await busySlots(chisinauToUtc(days[0], 0), chisinauToUtc(days[days.length - 1], 24));
      const now = Date.now();
      return res.status(200).json({
        topics: TOPICS,
        booking: await activeBooking(user.id),
        days: days.map((date) => ({
          date,
          slots: HOURS.filter((h) => {
            const at = chisinauToUtc(date, h);
            return at - now >= MIN_LEAD_MS && !busy.has(at);
          }).map(hhmm),
        })),
      });
    }

    if (req.method === "POST") {
      const body = readBody(req);
      const topic = TOPICS.includes(body.topic) ? body.topic : null;
      const date = String(body.date || "");
      const match = /^(\d{2}):00$/.exec(String(body.time || ""));
      const hour = match ? Number(match[1]) : NaN;

      if (!topic) return res.status(400).json({ error: "Выбери тему консультации." });
      if (!upcomingDays().includes(date)) return res.status(400).json({ error: "Выбери дату в ближайшие 14 дней.", refresh: true });
      if (!HOURS.includes(hour)) return res.status(400).json({ error: "Выбери время из списка.", refresh: true });
      const at = chisinauToUtc(date, hour);
      if (at - Date.now() < MIN_LEAD_MS) {
        return res.status(409).json({ error: "На это время записаться уже нельзя. Выбери другое.", refresh: true });
      }

      const picked = pickPhone(body, user);
      if (picked.error) return res.status(400).json({ error: picked.error });

      const name = clean([user.first_name, user.last_name].filter(Boolean).join(" "), 80) || "Без имени";
      const username = user.username ? clean(user.username, 64) : null;

      let lead;
      try {
        [lead] = await supabase("leads", {
          method: "POST",
          body: {
            name, phone: picked.phone || "", topic,
            source: "Telegram", status: BOOKED,
            telegram_id: user.id, telegram_username: username,
            consultation_at: new Date(at).toISOString(),
          },
          prefer: "return=representation",
        });
      } catch (err) {
        // Уникальные индексы БД: слот уже занят или у пользователя уже есть запись
        const text = String(err.message);
        if (text.includes("leads_consultation_slot_uniq")) {
          return res.status(409).json({ error: "Это время только что заняли. Выбери другое.", refresh: true });
        }
        if (text.includes("leads_telegram_active_uniq")) {
          return res.status(409).json({ error: "У тебя уже есть запись на консультацию.", refresh: true });
        }
        throw err;
      }

      // Запись уже сохранена, поэтому сбой Telegram не должен ломать ответ
      try {
        await telegram([
          `<b>Запись на консультацию #${lead.id}</b>`,
          `Имя: ${escapeHtml(name)}`,
          username ? `Telegram: @${escapeHtml(username)}` : `Telegram ID: ${user.id} (без username)`,
          picked.phone ? `Телефон: ${escapeHtml(picked.phone)}` : "Телефон: не указан",
          `Тема: ${escapeHtml(topic)}`,
          `Когда: ${formatWhen(at)}`,
          "Источник: Telegram Mini App",
        ].join("\n"));
      } catch (err) {
        console.error(err);
      }

      return res.status(201).json({ ok: true, id: lead.id, topic, when: formatWhen(at) });
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Метод не поддерживается" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Не получилось. Попробуй ещё раз чуть позже." });
  }
}
