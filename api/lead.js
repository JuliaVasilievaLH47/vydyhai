// POST /api/lead — принимает заявку с сайта, сохраняет в Supabase и пишет владельцу в Telegram
import { supabase, telegram, escapeHtml, readBody, clean } from "./_lib.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Метод не поддерживается" });
  }

  const body = readBody(req);

  // Скрытое поле-ловушка: люди его не видят, а боты заполняют
  if (body.website) return res.status(200).json({ ok: true });

  const name = clean(body.name, 80);
  const phone = clean(body.phone, 40);
  const topic = clean(body.topic, 40);
  const comment = clean(body.comment, 1000);
  const ageNum = parseInt(body.age, 10);
  const age = ageNum >= 5 && ageNum <= 120 ? ageNum : null;

  if (!name && !phone) return res.status(400).json({ error: "Форма пустая. Напиши имя и телефон." });
  if (!name) return res.status(400).json({ error: "Напиши, как к тебе обращаться." });
  if (phone.replace(/\D/g, "").length < 6) {
    return res.status(400).json({ error: "Проверь номер телефона: в нём должно быть хотя бы 6 цифр." });
  }

  let lead;
  try {
    [lead] = await supabase("leads", {
      method: "POST",
      body: { name, phone, age, topic, comment },
      prefer: "return=representation",
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Не получилось сохранить заявку. Позвони нам: +373 79 537 088." });
  }

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
