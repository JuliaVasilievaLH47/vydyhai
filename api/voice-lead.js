// POST /api/voice-lead — заявка от голосового агента ElevenLabs (инструмент create_lead).
// Принимает запрос только с заголовком "X-Voice-Secret: <VOICE_SECRET>". Секрет хранится в Vercel
// и в сейфе ElevenLabs (Workspace secrets), браузер посетителя его не видит.
// Запись в историю этапов («создана → Новая») делает триггер в базе.
// Лимит заявок (аудит безопасности, N5): таблица voice_attempts, миграция 008.
import { supabase, telegram, escapeHtml, readBody, clean, phoneOk, safeEqual, env, ipHash, countAttempt, ipAlertText } from "./_lib.js";

const TOPICS = ["Врач", "Психолог", "Семинар", "Перезвонить"];

// Все запросы приходят с серверов ElevenLabs, поэтому лимит по IP не годится: считаем по телефону.
// Защищает от посетителя, который уговорит агента создать много заявок подряд.
const WINDOW_MIN = 60;      // окно подсчёта, минут
const LIMIT_PER_PHONE = 2;  // заявок с одного телефона за окно
const LIMIT_TOTAL = 10;     // заявок голосом всего за окно
const KEEP_HOURS = 24;      // старые записи счётчика удаляются

const notify = (text) => telegram(text).catch((e) => console.error("Telegram:", e.message));

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
  // Аудит M4: только тема обращения. Предел на сервере — на случай, если агент напишет длиннее
  const summary = clean(body.summary, 300);
  const ageNum = parseInt(body.age, 10);
  const age = ageNum >= 5 && ageNum <= 120 ? ageNum : null;

  // Ошибки проверки отдаём с кодом 200 и ok:false: агент читает текст и переспрашивает посетителя.
  const fail = (error) => res.status(200).json({ ok: false, error });
  if (body.consent !== true && body.consent !== "true") {
    return fail("Нет согласия на обработку контактов. Спроси согласие и отправь заявку ещё раз.");
  }
  if (!name) return fail("Не хватает имени. Спроси, как обращаться к посетителю.");
  if (!phoneOk(phone)) return fail("В телефоне меньше 6 цифр. Переспроси номер.");

  // Лимит считаем после проверки полей: агент переспрашивает бесплатно, а сохранение и уведомление ограничены.
  // В базу идёт отпечаток телефона (только цифры), а не сам номер.
  let perIp, total, ipAlert;
  try {
    ({ perIp, total, ipAlert } = await countAttempt("voice_attempts", ipHash("voice", phone.replace(/\D/g, "")), {
      windowMin: WINDOW_MIN, limitPerIp: LIMIT_PER_PHONE, limitTotal: LIMIT_TOTAL,
    }));
  } catch (e) {
    // Счётчик недоступен — заявку не сохраняем, а не сохраняем без лимита
    console.error("voice_attempts:", e.message);
    return res.status(503).json({ ok: false, error: "Не получилось сохранить заявку. Предложи оставить её через форму на сайте." });
  }

  if (perIp > LIMIT_PER_PHONE) {
    if (ipAlert) {
      await notify(ipAlertText(`⚠️ Голосовой агент: ${LIMIT_PER_PHONE} заявки с одного телефона за ${WINDOW_MIN} минут. Новые заявки с этим номером не сохраняются час.`, ipAlert, "номер"));
    }
    return fail("Заявка с этим номером уже принята, повторно отправлять не нужно. Скажи, что с посетителем свяжутся в течение суток.");
  }
  if (total > LIMIT_TOTAL) {
    if (total === LIMIT_TOTAL + 1) {
      await notify(`⚠️ Голосовой агент: ${LIMIT_TOTAL} заявок за ${WINDOW_MIN} минут. Похоже на спам. Заявки голосом не сохраняются час, проверьте воронку.`);
    }
    return fail("Сейчас заявку голосом сохранить нельзя. Предложи оставить её через форму на сайте.");
  }

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

  // Старые записи счётчика удаляем. Сбой уборки не мешает заявке.
  const old = new Date(Date.now() - KEEP_HOURS * 3600e3).toISOString();
  await supabase(`voice_attempts?at=lt.${encodeURIComponent(old)}`, { method: "DELETE" })
    .catch((e) => console.error("voice_attempts cleanup:", e.message));

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
