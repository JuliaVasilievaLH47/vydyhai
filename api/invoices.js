// Счета на оплату. Все запросы только для админа с токеном.
//   GET   /api/invoices?lead_id=N   — счета клиента (свежие сверху)
//   GET   /api/invoices?id=N&pdf=1  — временная ссылка на PDF (5 минут)
//   POST  /api/invoices             — выставить счёт: {lead_id, items: [{title, qty, price}], due_on}
//   PATCH /api/invoices             — отметить оплату: {id, paid: true}; клиент переходит на этап «Оплачено»
// Номер счёта = id строки. Суммы считаются в целых копейках.
// PDF уходит клиенту в Telegram, если он пришёл из Mini App. Иначе — админу в чат с пометкой.
import {
  supabase, isAdmin, readBody, clean, escapeHtml, telegramDocument,
  storageUpload, storageRemove, storageSignedUrl, INVOICES_BUCKET, PAID_STAGE,
} from "./_lib.js";
import { invoicePdf, formatCents } from "./_invoice-pdf.js";

const CURRENCY = "MDL";
const MAX_ITEMS = 10;
const MAX_QTY = 1000;
const MAX_PRICE_CENTS = 100_000_000; // 1 000 000 MDL за единицу
const DEFAULT_DUE_DAYS = 7;
const MAX_DUE_DAYS = 90;

class UserError extends Error {}

// Сегодняшняя дата по Кишинёву: "ГГГГ-ММ-ДД"
function chisinauToday() {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Chisinau", year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date()).map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}`;
}
const addDays = (iso, days) => new Date(Date.parse(iso + "T00:00:00Z") + days * 86400000).toISOString().slice(0, 10);
const formatDate = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

// "250,50" / 250.5 → 25050 копеек; null, если цена неверная
function toCents(value) {
  const s = String(value ?? "").trim().replace(/\s/g, "").replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return cents > 0 && cents <= MAX_PRICE_CENTS ? cents : null;
}

function readItems(raw) {
  if (!Array.isArray(raw) || !raw.length) throw new UserError("Добавьте хотя бы одну позицию.");
  if (raw.length > MAX_ITEMS) throw new UserError(`В счёте не больше ${MAX_ITEMS} позиций.`);
  return raw.map((item, i) => {
    const n = i + 1;
    const title = clean(item?.title, 120);
    const qty = Number(item?.qty);
    const price_cents = toCents(item?.price);
    if (!title) throw new UserError(`Позиция ${n}: укажите название.`);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) throw new UserError(`Позиция ${n}: количество — целое число от 1 до ${MAX_QTY}.`);
    if (price_cents === null) throw new UserError(`Позиция ${n}: цена — число больше нуля, например 500 или 250,50.`);
    return { title, qty, price_cents };
  });
}

function readDue(raw, today) {
  if (raw === undefined || raw === "") return addDays(today, DEFAULT_DUE_DAYS);
  const s = String(raw);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s + "T00:00:00Z")) || addDays(s, 0) !== s) {
    throw new UserError("Неверная дата оплаты.");
  }
  if (s < today) throw new UserError("Срок оплаты не может быть раньше сегодняшнего дня.");
  if (s > addDays(today, MAX_DUE_DAYS)) throw new UserError(`Срок оплаты — не дальше ${MAX_DUE_DAYS} дней.`);
  return s;
}

async function createInvoice(body) {
  const leadId = Number(body.lead_id);
  if (!Number.isInteger(leadId) || leadId < 1) throw new UserError("Неверный номер клиента.");
  const today = chisinauToday();
  const items = readItems(body.items);
  const due_on = readDue(body.due_on, today);
  const total_cents = items.reduce((sum, x) => sum + x.qty * x.price_cents, 0);

  const [lead] = await supabase(`leads?id=eq.${leadId}&select=id,name,phone,telegram_id,telegram_username`);
  if (!lead) throw new UserError("Клиент не найден.");

  // Сначала строка (она даёт номер счёта), потом PDF. Если PDF не получился — строку удаляем.
  const [invoice] = await supabase("invoices", {
    method: "POST",
    body: { lead_id: leadId, issued_on: today, due_on, currency: CURRENCY, items, total_cents },
    prefer: "return=representation",
  });
  const filePath = `${today.slice(0, 7)}/${invoice.id}.pdf`;
  let pdf;
  try {
    pdf = await invoicePdf({ ...invoice, number: invoice.id }, lead);
    await storageUpload(filePath, pdf, "application/pdf", INVOICES_BUCKET);
  } catch (err) {
    await supabase(`invoices?id=eq.${invoice.id}`, { method: "DELETE" }).catch((e) => console.error(e));
    throw err;
  }
  await supabase(`invoices?id=eq.${invoice.id}`, { method: "PATCH", body: { file_path: filePath } }).catch(async (err) => {
    await storageRemove(filePath, INVOICES_BUCKET).catch(() => {});
    await supabase(`invoices?id=eq.${invoice.id}`, { method: "DELETE" }).catch(() => {});
    throw err;
  });

  // Отправка: клиенту (если есть Telegram), иначе или при ошибке — админу с пометкой
  const filename = `Счёт-${invoice.id}.pdf`;
  const sum = `${formatCents(total_cents)} ${CURRENCY}`;
  let sent = false;
  let reason = "у клиента нет Telegram";
  if (lead.telegram_id) {
    try {
      await telegramDocument({
        chatId: lead.telegram_id, buffer: pdf, filename,
        caption: `Привет! Это счёт № ${invoice.id} на ${sum}. Оплатить до ${formatDate(due_on)}.`,
      });
      sent = true;
    } catch (err) {
      console.error(err);
      reason = "Telegram не доставил сообщение";
    }
  }
  if (sent) {
    await supabase(`invoices?id=eq.${invoice.id}`, { method: "PATCH", body: { sent_to_client: true } }).catch((e) => console.error(e));
  } else {
    await telegramDocument({
      buffer: pdf, filename,
      caption: `🧾 Счёт № ${invoice.id} для ${escapeHtml(lead.name)} на ${sum}\n⚠️ Клиенту не отправлен: ${reason}.`,
    }).catch((e) => console.error(e));
  }
  return { ...invoice, file_path: filePath, sent_to_client: sent };
}

async function markPaid(body) {
  const id = Number(body.id);
  if (!Number.isInteger(id) || id < 1 || body.paid !== true) throw new UserError("Нужен номер счёта и paid: true.");

  const [invoice] = await supabase(`invoices?id=eq.${id}&status=eq.${encodeURIComponent("Не оплачен")}`, {
    method: "PATCH",
    body: { status: "Оплачен", paid_at: new Date().toISOString() },
    prefer: "return=representation",
  });
  if (!invoice) {
    const [exists] = await supabase(`invoices?id=eq.${id}&select=id`);
    throw new UserError(exists ? "Этот счёт уже отмечен оплаченным." : "Счёт не найден.");
  }

  // Клиента — на этап «Оплачено». Запись в историю делает триггер, мы только подписываем её.
  const [moved] = await supabase(
    `leads?id=eq.${invoice.lead_id}&status=neq.${encodeURIComponent(PAID_STAGE)}`,
    { method: "PATCH", body: { status: PAID_STAGE }, prefer: "return=representation" },
  );
  if (moved) {
    const [last] = await supabase(`lead_stage_history?lead_id=eq.${invoice.lead_id}&select=id&order=id.desc&limit=1`);
    if (last) await supabase(`lead_stage_history?id=eq.${last.id}`, { method: "PATCH", body: { note: `Оплачен счёт № ${id}` } });
  }
  return invoice;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!isAdmin(req)) return res.status(401).json({ error: "Нужно войти" });

  try {
    if (req.method === "GET") {
      if (req.query.id !== undefined) {
        const id = Number(req.query.id);
        if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "Неверный номер счёта" });
        const [row] = await supabase(`invoices?id=eq.${id}&select=file_path`);
        if (!row || !row.file_path) return res.status(404).json({ error: "PDF не найден" });
        return res.status(200).json({ url: await storageSignedUrl(row.file_path, 300, INVOICES_BUCKET) });
      }
      const leadId = Number(req.query.lead_id);
      if (!Number.isInteger(leadId) || leadId < 1) return res.status(400).json({ error: "Неверный номер клиента" });
      return res.status(200).json(await supabase(`invoices?lead_id=eq.${leadId}&select=*&order=id.desc`));
    }
    if (req.method === "POST") return res.status(201).json(await createInvoice(readBody(req)));
    if (req.method === "PATCH") return res.status(200).json(await markPaid(readBody(req)));

    res.setHeader("Allow", "GET, POST, PATCH");
    return res.status(405).json({ error: "Метод не поддерживается" });
  } catch (err) {
    if (err instanceof UserError) return res.status(400).json({ error: err.message });
    console.error(err);
    return res.status(500).json({ error: "Ошибка сервера при работе со счетами" });
  }
}
