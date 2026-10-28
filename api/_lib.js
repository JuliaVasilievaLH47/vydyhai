// Общие помощники для серверных функций. Файлы с "_" в начале Vercel не публикует как адреса.
import crypto from "node:crypto";

export const STATUSES = ["новая", "в работе", "закрыта"];

function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Не задана переменная окружения ${name}`);
  return value;
}

// Запрос к таблицам Supabase через REST. Ключ берётся только из настроек Vercel.
export async function supabase(path, { method = "GET", body, prefer } = {}) {
  const url = env("SUPABASE_URL").replace(/\/+$/, "") + "/rest/v1/" + path;
  const key = env("SUPABASE_SERVICE_KEY");
  const headers = { apikey: key, "Content-Type": "application/json" };
  // Старые ключи (JWT) нужно передавать ещё и в Authorization, новые sb_secret_… — нет
  if (!key.startsWith("sb_")) headers.Authorization = `Bearer ${key}`;
  if (prefer) headers.Prefer = prefer;

  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

export async function telegram(text) {
  const token = env("TELEGRAM_BOT_TOKEN");
  const chatId = env("TELEGRAM_CHAT_ID");
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  if (!res.ok) throw new Error(`Telegram ${res.status}: ${await res.text()}`);
}

export const escapeHtml = (s) =>
  String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

export function readBody(req) {
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body || "{}"); } catch { return {}; }
  }
  return req.body || {};
}

export function clean(value, max) {
  return String(value ?? "").trim().slice(0, max);
}

// Сравнение строк без утечки по времени
export function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Токен админа: "<время истечения>.<подпись>", подпись делается секретом из SESSION_SECRET
const sign = (data) => crypto.createHmac("sha256", env("SESSION_SECRET")).update(data).digest("base64url");

export function makeToken(hours = 12) {
  const exp = String(Date.now() + hours * 3600 * 1000);
  return `${exp}.${sign(exp)}`;
}

export function isAdmin(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const [exp, sig] = token.split(".");
  if (!exp || !sig) return false;
  return safeEqual(sig, sign(exp)) && Number(exp) > Date.now();
}
