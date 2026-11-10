// PDF счёта на оплату. Собирается на сервере библиотекой pdf-lib со шрифтом Manrope (кириллица).
// Шрифты лежат в api/_fonts и попадают в функцию через includeFiles в vercel.json.
import { readFileSync } from "node:fs";
import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { SELLER } from "./_lib.js";

const FONT_REGULAR = readFileSync(new URL("./_fonts/Manrope-Regular.ttf", import.meta.url));
const FONT_BOLD = readFileSync(new URL("./_fonts/Manrope-Bold.ttf", import.meta.url));

const INK = rgb(0.08, 0.07, 0.14);
const MUTED = rgb(0.34, 0.33, 0.45);
const LINE = rgb(0.79, 0.8, 0.89);
const ACCENT = rgb(1, 0.3, 0.18);

// 12345 копеек → "123,45"
export const formatCents = (cents) =>
  (cents / 100).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/ /g, " ");

// "2026-11-17" → "17.11.2026"
const formatDate = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

// invoice: {number, issued_on, due_on, currency, items: [{title, qty, price_cents}], total_cents}
// lead: {name, phone, telegram_username}
export async function invoicePdf(invoice, lead) {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setTitle(`Счёт № ${invoice.number}`);
  pdf.setAuthor(SELLER.name);
  const regular = await pdf.embedFont(FONT_REGULAR, { subset: true });
  const bold = await pdf.embedFont(FONT_BOLD, { subset: true });

  const page = pdf.addPage([595.28, 841.89]); // A4
  const left = 50, right = 545;
  let y = 790;

  const text = (s, x, size, font = regular, color = INK) => page.drawText(String(s), { x, y, size, font, color });
  const textRight = (s, x, size, font = regular, color = INK) =>
    page.drawText(String(s), { x: x - font.widthOfTextAtSize(String(s), size), y, size, font, color });
  const line = (yy, thickness = 1, color = LINE) =>
    page.drawLine({ start: { x: left, y: yy }, end: { x: right, y: yy }, thickness, color });

  // Перенос длинного названия по словам в пределах ширины колонки
  function wrap(s, font, size, width) {
    const lines = [];
    let cur = "";
    for (const word of String(s).split(/\s+/)) {
      const next = cur ? cur + " " + word : word;
      if (font.widthOfTextAtSize(next, size) <= width) { cur = next; continue; }
      if (cur) lines.push(cur);
      cur = word;
      // Слово длиннее колонки режем по буквам
      while (font.widthOfTextAtSize(cur, size) > width) {
        let i = cur.length;
        while (i > 1 && font.widthOfTextAtSize(cur.slice(0, i), size) > width) i--;
        lines.push(cur.slice(0, i));
        cur = cur.slice(i);
      }
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [""];
  }

  // Шапка
  page.drawRectangle({ x: left, y: y - 4, width: 6, height: 26, color: ACCENT });
  y += 2;
  text(`Счёт на оплату № ${invoice.number}`, left + 16, 20, bold);
  y -= 22;
  text(`от ${formatDate(invoice.issued_on)}`, left + 16, 11, regular, MUTED);

  // Продавец и покупатель
  y -= 40;
  const block = (title, rows, x) => {
    let yy = y;
    page.drawText(title, { x, y: yy, size: 9, font: bold, color: MUTED });
    yy -= 16;
    rows.filter(Boolean).forEach((r, i) => {
      page.drawText(r, { x, y: yy, size: i === 0 ? 11 : 9.5, font: i === 0 ? bold : regular, color: INK });
      yy -= i === 0 ? 15 : 13;
    });
    return yy;
  };
  const contact = lead.phone || (lead.telegram_username ? "@" + lead.telegram_username : "");
  const yA = block("ПОСТАВЩИК", [SELLER.name, SELLER.address, `IDNO: ${SELLER.idno}`, `IBAN: ${SELLER.iban}`, SELLER.bank], left);
  const yB = block("ПЛАТЕЛЬЩИК", [lead.name, contact], 320);
  y = Math.min(yA, yB) - 20;

  // Таблица позиций
  const cols = { n: left, title: left + 26, qty: 380, price: 465, sum: right };
  const titleWidth = cols.qty - 50 - cols.title;
  line(y + 14, 1.5, INK);
  text("№", cols.n, 9, bold, MUTED);
  text("Наименование", cols.title, 9, bold, MUTED);
  textRight("Кол-во", cols.qty, 9, bold, MUTED);
  textRight("Цена", cols.price, 9, bold, MUTED);
  textRight(`Сумма, ${invoice.currency}`, cols.sum, 9, bold, MUTED);
  y -= 10;
  line(y, 1, INK);

  invoice.items.forEach((item, i) => {
    const lines = wrap(item.title, regular, 10.5, titleWidth);
    y -= 18;
    text(i + 1, cols.n, 10.5);
    textRight(item.qty, cols.qty, 10.5);
    textRight(formatCents(item.price_cents), cols.price, 10.5);
    textRight(formatCents(item.price_cents * item.qty), cols.sum, 10.5);
    lines.forEach((l, j) => { if (j) y -= 14; text(l, cols.title, 10.5); });
    y -= 8;
    line(y);
  });

  // Итог
  y -= 26;
  textRight(`Итого к оплате: ${formatCents(invoice.total_cents)} ${invoice.currency}`, right, 14, bold);
  y -= 20;
  textRight(`Оплатить до ${formatDate(invoice.due_on)}`, right, 10.5, regular, MUTED);

  // Подвал
  y = 70;
  line(y + 16);
  text("В назначении платежа укажите номер счёта.", left, 9, regular, MUTED);
  y -= 13;
  text("Учебный проект «Выдыхай». Реквизиты вымышленные, платить по ним нельзя.", left, 9, regular, MUTED);

  return Buffer.from(await pdf.save());
}
