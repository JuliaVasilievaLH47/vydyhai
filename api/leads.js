// GET /api/leads?status=… — список заявок (свежие сверху); PATCH /api/leads — смена статуса.
// Оба запроса только для админа с токеном.
import { supabase, isAdmin, readBody, STATUSES } from "./_lib.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!isAdmin(req)) return res.status(401).json({ error: "Нужно войти" });

  try {
    if (req.method === "GET") {
      let path = "leads?select=*&order=created_at.desc";
      const status = req.query.status;
      if (status && STATUSES.includes(status)) path += `&status=eq.${encodeURIComponent(status)}`;
      return res.status(200).json(await supabase(path));
    }

    if (req.method === "PATCH") {
      const { id, status } = readBody(req);
      if (!Number.isInteger(id) || !STATUSES.includes(status)) {
        return res.status(400).json({ error: "Нужны id заявки и статус: новая, в работе или закрыта" });
      }
      const [lead] = await supabase(`leads?id=eq.${id}`, {
        method: "PATCH",
        body: { status },
        prefer: "return=representation",
      });
      if (!lead) return res.status(404).json({ error: "Заявка не найдена" });
      return res.status(200).json(lead);
    }

    res.setHeader("Allow", "GET, PATCH");
    return res.status(405).json({ error: "Метод не поддерживается" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Ошибка сервера при работе с заявками" });
  }
}
