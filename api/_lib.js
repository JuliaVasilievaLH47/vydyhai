// Общие помощники для серверных функций. Файлы с "_" в начале Vercel не публикует как адреса.
import crypto from "node:crypto";

// Этапы воронки. Тот же список — в admin.html и в check-ограничении supabase.sql.
// Источники («Сайт» / «Вручную») задаются в api/lead.js и api/leads.js, ограничение — в supabase.sql.
export const STATUSES = ["Новая", "Связались", "Записан на консультацию", "Консультация проведена", "Отказ"];

// В телефоне должно быть хотя бы 6 цифр (та же проверка — в формах index.html и admin.html)
export const phoneOk = (phone) => String(phone).replace(/\D/g, "").length >= 6;

// Категории расходов. Тот же список — в admin.html и в check-ограничении expenses (supabase.sql).
export const CATEGORIES = ["Реклама", "Печать материалов", "Консультанты", "Сервисы и подписки", "Прочее"];

// Файлы чеков: допустимые типы и размер. 3 МБ после base64 ≈ 4 МБ тела запроса —
// укладывается в лимит Vercel 4,5 МБ. Фото браузер сжимает заранее, PDF приходит как есть.
export const FILE_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
export const MAX_FILE_BYTES = 3 * 1024 * 1024;
const RECEIPTS_BUCKET = "receipts";

export function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Не задана переменная окружения ${name}`);
  return value;
}

const supabaseUrl = () => env("SUPABASE_URL").replace(/\/+$/, "");

function supabaseHeaders(extra) {
  const key = env("SUPABASE_SERVICE_KEY");
  const headers = { apikey: key, ...extra };
  // Старые ключи (JWT) нужно передавать ещё и в Authorization, новые sb_secret_… — нет
  if (!key.startsWith("sb_")) headers.Authorization = `Bearer ${key}`;
  return headers;
}

// Запрос к таблицам Supabase через REST. Ключ берётся только из настроек Vercel.
export async function supabase(path, { method = "GET", body, prefer } = {}) {
  const headers = supabaseHeaders({ "Content-Type": "application/json" });
  if (prefer) headers.Prefer = prefer;

  const res = await fetch(supabaseUrl() + "/rest/v1/" + path, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

// ---------- Supabase Storage: приватный bucket receipts ----------

export async function storageUpload(path, buffer, type) {
  const res = await fetch(`${supabaseUrl()}/storage/v1/object/${RECEIPTS_BUCKET}/${path}`, {
    method: "POST",
    headers: supabaseHeaders({ "Content-Type": type, "x-upsert": "false" }),
    body: buffer,
  });
  if (!res.ok) throw new Error(`Storage upload ${res.status}: ${await res.text()}`);
}

export async function storageRemove(path) {
  const res = await fetch(`${supabaseUrl()}/storage/v1/object/${RECEIPTS_BUCKET}`, {
    method: "DELETE",
    headers: supabaseHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ prefixes: [path] }),
  });
  if (!res.ok) throw new Error(`Storage delete ${res.status}: ${await res.text()}`);
}

// Временная ссылка на файл (по умолчанию 5 минут)
export async function storageSignedUrl(path, seconds = 300) {
  const res = await fetch(`${supabaseUrl()}/storage/v1/object/sign/${RECEIPTS_BUCKET}/${path}`, {
    method: "POST",
    headers: supabaseHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ expiresIn: seconds }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Storage sign ${res.status}: ${text}`);
  const { signedURL } = JSON.parse(text);
  // Supabase отдаёт относительный путь вида /object/sign/… (в старых версиях — /storage/v1/object/sign/…)
  return supabaseUrl() + (signedURL.startsWith("/storage/v1") ? "" : "/storage/v1") + signedURL;
}

// ---------- Файл чека из тела запроса: {file: <base64>, type: <mime>} ----------

const SIGNATURES = {
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/png": (b) => b.subarray(0, 4).toString("hex") === "89504e47",
  "image/webp": (b) => b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP",
  "application/pdf": (b) => b.subarray(0, 5).toString("ascii") === "%PDF-",
};

// Возвращает {buffer, base64, type} или {error: "текст для админа"}
export function readFile(body) {
  const type = String(body.type || "");
  if (!FILE_TYPES.includes(type)) return { error: "Подходят только фото (JPEG, PNG, WebP) или PDF." };
  const base64 = typeof body.file === "string" ? body.file.replace(/^data:[^,]*,/, "") : "";
  if (!base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return { error: "Файл не получен. Выберите его ещё раз." };
  const buffer = Buffer.from(base64, "base64");
  if (buffer.length > MAX_FILE_BYTES) return { error: "Файл больше 3 МБ. Сожмите его или сфотографируйте чек." };
  // Проверяем, что содержимое действительно того типа, который заявлен
  if (!SIGNATURES[type](buffer)) return { error: "Файл повреждён или его тип не совпадает с содержимым." };
  return { buffer, base64, type };
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

// ---------- Telegram Mini App ----------

// Проверка строки, подписанной Telegram (initData или ответ requestContact), по документации
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app :
//   secret_key = HMAC_SHA256(key = "WebAppData", message = bot_token)
//   hash       = hex(HMAC_SHA256(key = secret_key, message = data_check_string)),
//   data_check_string — все поля, кроме hash, по алфавиту, "key=value" через "\n".
// Возвращает объект полей или null, если подпись неверна или данные старше maxAgeSec.
export function verifyTelegramData(raw, maxAgeSec = 24 * 3600) {
  if (typeof raw !== "string" || !raw || raw.length > 8192) return null;
  const params = new URLSearchParams(raw);
  const hash = params.get("hash") || "";
  if (!/^[0-9a-f]{64}$/.test(hash)) return null;

  const pairs = [...params].filter(([k]) => k !== "hash").sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const secret = crypto.createHmac("sha256", "WebAppData").update(env("TELEGRAM_BOT_TOKEN")).digest();
  const sign = (list) => crypto.createHmac("sha256", secret).update(list.map(([k, v]) => `${k}=${v}`).join("\n")).digest();
  const expected = Buffer.from(hash, "hex");

  let ok = crypto.timingSafeEqual(sign(pairs), expected);
  // Поле signature нужно для другой (Ed25519) проверки; в части описаний его исключают и из hash-проверки.
  // Принимаем оба варианта — подделать любой из них без токена бота всё равно нельзя.
  if (!ok && params.has("signature")) ok = crypto.timingSafeEqual(sign(pairs.filter(([k]) => k !== "signature")), expected);
  if (!ok) return null;

  const age = Date.now() / 1000 - Number(params.get("auth_date"));
  if (!Number.isFinite(age) || age > maxAgeSec || age < -300) return null;
  return Object.fromEntries(pairs);
}

// Пользователь Mini App — только из проверенного initData (заголовок "Authorization: tma <initData>").
// То, что браузер присылает в теле запроса, для определения пользователя не используется.
export function telegramUser(req) {
  const header = req.headers.authorization || "";
  const data = verifyTelegramData(header.startsWith("tma ") ? header.slice(4) : "");
  if (!data || !data.user) return null;
  try {
    const user = JSON.parse(data.user);
    return Number.isSafeInteger(user.id) && user.id > 0 ? user : null;
  } catch {
    return null;
  }
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
