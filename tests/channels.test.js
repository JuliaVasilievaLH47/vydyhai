// Тесты лимитов голосового агента и Mini App (аудит N5). Запуск из папки проекта: node --test tests/
// К настоящей базе и Telegram тест не обращается: fetch подменён фальшивой базой в памяти.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.SUPABASE_URL = "https://fake.supabase.test";
process.env.SUPABASE_SERVICE_KEY = "sb_secret_fake";
process.env.SESSION_SECRET = "test-secret";
process.env.TELEGRAM_BOT_TOKEN = "fake-bot-token";
process.env.TELEGRAM_CHAT_ID = "1";
process.env.VOICE_SECRET = "voice-test-secret";

const { default: voiceHandler } = await import("../api/voice-lead.js");
const { default: appHandler } = await import("../api/app.js");

// ---------- Фальшивая база: таблицы — массивы строк ----------
let db, nextId, telegramSent, dbDown;

beforeEach(() => {
  db = { voice_attempts: [], app_attempts: [], leads: [] };
  nextId = 1;
  telegramSent = [];
  dbDown = false;
});

const reply = (status, data) => new Response(data === undefined ? null : JSON.stringify(data), { status });

globalThis.fetch = async (url, { method = "GET", body } = {}) => {
  const u = new URL(url);
  if (u.hostname === "api.telegram.org") {
    telegramSent.push(JSON.parse(body).text);
    return reply(200, { ok: true });
  }
  if (dbDown) return reply(500, { message: "база недоступна" });
  const table = u.pathname.replace("/rest/v1/", "");
  const rows = db[table];
  if (!rows) return reply(404, { message: "нет таблицы " + table });

  const match = (r) => [...u.searchParams].every(([key, value]) => {
    if (key === "select" || key === "limit") return true;
    const [op, ...rest] = value.split(".");
    const arg = rest.join(".");
    if (op === "eq") return String(r[key]) === arg;
    if (op === "gte") return r[key] >= arg;
    if (op === "lt") return r[key] < arg;
    if (op === "is") return r[key] === (arg === "true");
    throw new Error("фальшивая база не знает фильтр " + value);
  });

  if (method === "POST") {
    const now = new Date().toISOString();
    const row = { id: nextId++, at: now, created_at: now, passed: false, ...JSON.parse(body) };
    rows.push(row);
    return reply(201, [row]);
  }
  if (method === "PATCH") {
    rows.filter(match).forEach((r) => Object.assign(r, JSON.parse(body)));
    return reply(204);
  }
  if (method === "DELETE") {
    db[table] = rows.filter((r) => !match(r));
    return reply(204);
  }
  const limit = Number(u.searchParams.get("limit") || Infinity);
  return reply(200, rows.filter(match).slice(0, limit).map((r) => ({ id: r.id })));
};

function call(handler, { headers = {}, body = {}, method = "POST" }) {
  const res = {
    statusCode: 200, headers: {}, data: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(data) { this.data = data; return this; },
  };
  return handler({ method, headers, body }, res).then(() => res);
}

// ---------- Голосовой агент ----------

const voice = (phone, secret = process.env.VOICE_SECRET) => call(voiceHandler, {
  headers: { "x-voice-secret": secret },
  body: { name: "Test", phone, consent: true, topic: "Психолог" },
});

test("voice: с одного телефона сохраняются 2 заявки, третья — отказ агенту, уведомление о блокировке одно", async () => {
  const r = [];
  for (let i = 0; i < 4; i++) r.push(await voice("+373 600 00 001"));
  assert.deepEqual(r.map((x) => x.statusCode), [201, 201, 200, 200]);
  assert.equal(r[2].data.ok, false, "третья заявка не сохранена");
  assert.equal(db.leads.length, 2);
  const alerts = telegramSent.filter((t) => t.includes("с одного телефона"));
  assert.equal(alerts.length, 1);
});

test("voice: тот же номер в другой записи (пробелы, скобки) считается одним телефоном", async () => {
  await voice("+373 600 00 002");
  await voice("+373(600)00-002");
  const third = await voice("37360000002");
  assert.equal(third.data.ok, false);
});

test("voice: 11 разных телефонов — сохраняются 10, уведомление об общем лимите одно", async () => {
  const r = [];
  for (let i = 0; i < 12; i++) r.push(await voice("+373 600 10 0" + String(i).padStart(2, "0")));
  assert.equal(db.leads.length, 10);
  assert.equal(r[10].data.ok, false);
  assert.equal(telegramSent.filter((t) => t.includes("Похоже на спам")).length, 1);
});

test("voice: неверный секрет — 401, счётчик не трогается", async () => {
  const r = await voice("+373 600 00 003", "wrong");
  assert.equal(r.statusCode, 401);
  assert.equal(db.voice_attempts.length, 0);
});

test("voice: сбой базы — 503, заявка без лимита не сохраняется", async () => {
  dbDown = true;
  const r = await voice("+373 600 00 004");
  assert.equal(r.statusCode, 503);
  assert.equal(r.data.ok, false);
});

// ---------- Mini App ----------

// initData, подписанный так же, как это делает Telegram (тот же алгоритм, что в verifyTelegramData)
function initData(userId) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: userId, first_name: "Test" }),
  });
  const check = [...params].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(process.env.TELEGRAM_BOT_TOKEN).digest();
  params.set("hash", crypto.createHmac("sha256", secret).update(check).digest("hex"));
  return params.toString();
}

// Свободный слот: завтра в 12:00 по Кишинёву
const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString("sv-SE", { timeZone: "Europe/Chisinau" });
const book = (userId) => call(appHandler, {
  headers: { authorization: "tma " + initData(userId) },
  body: { topic: "Психолог", date: tomorrow, time: "12:00", phone: "+373 600 00 000", consent: true },
});

test("app: один аккаунт — 5 попыток записи, шестая 429, уведомление о блокировке одно", async () => {
  const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await book(1001)).statusCode);
  assert.deepEqual(codes.slice(5), [429, 429]);
  assert.equal(telegramSent.filter((t) => t.includes("с одного аккаунта")).length, 1);

  const other = await book(1002);
  assert.notEqual(other.statusCode, 429, "другой аккаунт не заблокирован");
});

test("app: 11 разных аккаунтов — одиннадцатый получает 429, уведомление об общем лимите одно", async () => {
  const codes = [];
  for (let id = 1; id <= 12; id++) codes.push((await book(2000 + id)).statusCode);
  assert.ok(codes.slice(0, 10).every((c) => c === 201));
  assert.deepEqual(codes.slice(10), [429, 429]);
  assert.equal(telegramSent.filter((t) => t.includes("с разных аккаунтов")).length, 1);
});

test("app: ошибка ввода не расходует лимит", async () => {
  for (let i = 0; i < 10; i++) {
    await call(appHandler, { headers: { authorization: "tma " + initData(3001) }, body: { topic: "нет такой" } });
  }
  assert.equal(db.app_attempts.length, 0);
  assert.equal((await book(3001)).statusCode, 201);
});

test("app: сбой базы — 503, запись без лимита не создаётся", async () => {
  dbDown = true;
  const r = await book(4001);
  assert.equal(r.statusCode, 503);
});
