// Расходы. Все запросы только для админа с токеном.
//   GET  /api/expenses?month=ГГГГ-ММ — расходы за месяц (по дате чека) + итоги по категориям и общий итог
//   GET  /api/expenses?file=ID       — временная ссылка (5 минут) на оригинал чека
//   POST /api/expenses               — сохранить проверенный расход вместе с файлом:
//                                      {file, type, amount, currency, date, vendor, category}
import crypto from "node:crypto";
import {
  supabase, isAdmin, readBody, readFile, clean,
  storageUpload, storageRemove, storageSignedUrl, CATEGORIES,
} from "./_lib.js";

const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" };

const currentMonth = () =>
  new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Chisinau" }).slice(0, 7);

function nextMonth(month) {
  let [y, m] = month.split("-").map(Number);
  if (++m > 12) { m = 1; y++; }
  return `${y}-${String(m).padStart(2, "0")}`;
}

// Итоги считаем в копейках/центах, чтобы не накапливать ошибки дробных чисел.
// Отдельно по каждой валюте: леи и евро не складываются.
function totals(items) {
  const byCurrency = {};
  for (const e of items) {
    const t = (byCurrency[e.currency] ??= { total: 0, categories: Object.fromEntries(CATEGORIES.map((c) => [c, 0])) });
    const cents = Math.round(Number(e.amount) * 100);
    t.total += cents;
    t.categories[e.category] = (t.categories[e.category] || 0) + cents;
  }
  return Object.entries(byCurrency).map(([currency, t]) => ({
    currency,
    total: t.total / 100,
    categories: CATEGORIES.map((c) => ({ category: c, amount: t.categories[c] / 100 })),
  }));
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!isAdmin(req)) return res.status(401).json({ error: "Нужно войти" });

  try {
    if (req.method === "GET") {
      if (req.query.file !== undefined) {
        const id = Number(req.query.file);
        if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "Неверный номер расхода" });
        const [row] = await supabase(`expenses?id=eq.${id}&select=file_path`);
        if (!row) return res.status(404).json({ error: "Расход не найден" });
        return res.status(200).json({ url: await storageSignedUrl(row.file_path, 300) });
      }

      const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(req.query.month || "") ? req.query.month : currentMonth();
      const items = await supabase(
        `expenses?select=id,created_at,expense_date,amount,currency,vendor,category,file_type` +
        `&expense_date=gte.${month}-01&expense_date=lt.${nextMonth(month)}-01` +
        `&order=expense_date.desc,id.desc`
      );
      return res.status(200).json({ month, items, totals: totals(items) });
    }

    if (req.method === "POST") {
      const body = readBody(req);
      const file = readFile(body);
      if (file.error) return res.status(400).json({ error: file.error });

      const amount = Math.round(Number(String(body.amount ?? "").replace(",", ".")) * 100) / 100;
      const currency = clean(body.currency, 3).toUpperCase() || "MDL";
      const date = String(body.date || "");
      const vendor = clean(body.vendor, 120);
      const category = body.category;

      if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: "Укажите сумму больше нуля." });
      if (!/^[A-Z]{3}$/.test(currency)) return res.status(400).json({ error: "Валюта — три латинские буквы, например MDL или EUR." });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) {
        return res.status(400).json({ error: "Укажите дату чека." });
      }
      if (!CATEGORIES.includes(category)) {
        return res.status(400).json({ error: `Выберите категорию: ${CATEGORIES.join(", ")}.` });
      }

      // Сначала файл, потом запись. Если запись не создалась — удаляем файл, чтобы не оставлять «сирот».
      const path = `${date.slice(0, 7)}/${crypto.randomUUID()}.${EXT[file.type]}`;
      await storageUpload(path, file.buffer, file.type);
      try {
        const [row] = await supabase("expenses", {
          method: "POST",
          body: { expense_date: date, amount, currency, vendor, category, file_path: path, file_type: file.type },
          prefer: "return=representation",
        });
        return res.status(201).json(row);
      } catch (err) {
        await storageRemove(path).catch((e) => console.error("Не удалось удалить файл после ошибки:", e));
        throw err;
      }
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Метод не поддерживается" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Ошибка сервера при работе с расходами" });
  }
}
