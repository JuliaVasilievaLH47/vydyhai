// POST /api/voice-lead — заявка от голосового агента ElevenLabs (инструмент create_lead).
// Принимает запрос только с заголовком "X-Voice-Secret: <VOICE_SECRET>". Секрет хранится в Vercel
// и в сейфе ElevenLabs (Workspace secrets), браузер посетителя его не видит.
// Запись в историю этапов («создана → Новая») делает триггер в базе.
import { supabase, telegram, escapeHtml, readBody, clean, phoneOk, safeEqual, env } from "./_lib.js";

const TOPICS = ["Врач", "Психолог", "Семинар", "Перезвонить"];

function authorized(req) {
  const secret = req.headers["x-voice-secret"];
  return typeof secret === "string" && secret !== "" && safeEqual(secret, env("VOICE_SECRET"));
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Метод не поддерживается" });
  }
  if (!authorized(req)) return res.status(401).json({ error: "Нужен секрет доступа" });

  const body = readBody(req);
  const name = clean(body.name, 80);
  const phone = clean(body.phone, 40);
  const topic = TOPICS.includes(body.topic) ? body.topic : null;
  const summary = clean(body.summary, 1000);
  const ageNum = parseInt(body.age, 10);
  const age = ageNum >= 5 && ageNum <= 120 ? ageNum : null;

  // Ошибки проверки отдаём с кодом 200 и ok:false: агент читает текст и переспрашивает посетителя.
  const fail = (error) => res.status(200).json({ ok: false, error });
  if (body.consent !== true && body.consent !== "true") {
    return fail("Нет согласия на обработку контактов. Спроси согласие и отправь заявку ещё раз.");
  }
  if (!name) return fail("Не хватает имени. Спроси, как обращаться к посетителю.");
  if (!phoneOk(phone)) return fail("В телефоне меньше 6 цифр. Переспроси номер.");

  let lead;
  try {
    [lead] = await supabase("leads", {
      method: "POST",
      body: { name, phone, age, topic, comment: summary || null, source: "Голос", status: "Новая" },
      prefer: "return=representation",
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: "Не получилось сохранить заявку. Предложи оставить её через форму на сайте." });
  }

  // Заявка уже сохранена, поэтому сбой Telegram не должен ломать ответ агенту
  try {
    const when = new Date(lead.created_at).toLocaleString("ru-RU", { timeZone: "Europe/Chisinau" });
    const lines = [
      `<b>Заявка голосом #${lead.id}</b>`,
      `Имя: ${escapeHtml(name)}`,
      `Телефон: ${escapeHtml(phone)}`,
      age ? `Возраст: ${age}` : null,
      topic ? `Нужно: ${escapeHtml(topic)}` : null,
      summary ? `О разговоре: ${escapeHtml(summary)}` : null,
      `Время: ${when}`,
    ].filter(Boolean);
    await telegram(lines.join("\n"));
  } catch (err) {
    console.error(err);
  }

  return res.status(201).json({ ok: true, id: lead.id, message: "Заявка сохранена. С посетителем свяжутся в течение суток." });
}
