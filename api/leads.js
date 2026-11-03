// CRM-клиенты. Все запросы только для админа с токеном.
//   GET   /api/leads           — все клиенты для доски (свежие сверху); ?status=… — только один этап
//   GET   /api/leads?id=N      — карточка клиента с историей этапов
//   POST  /api/leads           — добавить клиента вручную: {name, phone, notes}
//   PATCH /api/leads           — сменить этап и/или заметки: {id, status?, notes?}
// Историю этапов пишет триггер в базе (при создании и каждой смене этапа).
import { supabase, isAdmin, readBody, clean, phoneOk, STATUSES } from "./_lib.js";

const NOTES_MAX = 2000;

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!isAdmin(req)) return res.status(401).json({ error: "Нужно войти" });

  try {
    if (req.method === "GET") {
      if (req.query.id !== undefined) {
        const id = Number(req.query.id);
        if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "Неверный номер клиента" });
        const [rows, history] = await Promise.all([
          supabase(`leads?id=eq.${id}&select=*`),
          supabase(`lead_stage_history?lead_id=eq.${id}&select=from_stage,to_stage,changed_at,note&order=changed_at.asc,id.asc`),
        ]);
        if (!rows.length) return res.status(404).json({ error: "Клиент не найден" });
        return res.status(200).json({ ...rows[0], history });
      }

      let path = "leads?select=*&order=created_at.desc";
      const status = req.query.status;
      if (status && STATUSES.includes(status)) path += `&status=eq.${encodeURIComponent(status)}`;
      return res.status(200).json(await supabase(path));
    }

    if (req.method === "POST") {
      const body = readBody(req);
      const name = clean(body.name, 80);
      const phone = clean(body.phone, 40);
      const notes = clean(body.notes, NOTES_MAX);
      if (!name) return res.status(400).json({ error: "Укажите имя клиента." });
      if (!phoneOk(phone)) {
        return res.status(400).json({ error: "Проверьте номер телефона: в нём должно быть хотя бы 6 цифр." });
      }
      const [lead] = await supabase("leads", {
        method: "POST",
        body: { name, phone, notes: notes || null, source: "Вручную", status: "Новая" },
        prefer: "return=representation",
      });
      return res.status(201).json(lead);
    }

    if (req.method === "PATCH") {
      const body = readBody(req);
      const patch = {};
      if (body.status !== undefined) {
        if (!STATUSES.includes(body.status)) {
          return res.status(400).json({ error: `Неизвестный этап. Допустимые: ${STATUSES.join(", ")}.` });
        }
        patch.status = body.status;
      }
      if (body.notes !== undefined) patch.notes = clean(body.notes, NOTES_MAX) || null;

      if (!Number.isInteger(body.id) || !Object.keys(patch).length) {
        return res.status(400).json({ error: "Нужны номер клиента и новый этап или заметки" });
      }
      const [lead] = await supabase(`leads?id=eq.${body.id}`, {
        method: "PATCH",
        body: patch,
        prefer: "return=representation",
      });
      if (!lead) return res.status(404).json({ error: "Клиент не найден" });
      return res.status(200).json(lead);
    }

    res.setHeader("Allow", "GET, POST, PATCH");
    return res.status(405).json({ error: "Метод не поддерживается" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Ошибка сервера при работе с клиентами" });
  }
}
