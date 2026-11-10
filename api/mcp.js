// MCP-сервер CRM «Выдыхай» для Claude Code: POST /api/mcp (протокол MCP, транспорт Streamable HTTP).
// Доступ только с заголовком "Authorization: Bearer <MCP_TOKEN>". Токен задаётся в Vercel.
// Инструменты:
//   leads_list     — заявки за период (по дате создания, время Кишинёва);
//   lead_find      — поиск клиента по имени или телефону;
//   lead_set_stage — смена этапа воронки. В истории переходов ставится пометка «MCP».
import { supabase, env, safeEqual, readBody, STATUSES } from "./_lib.js";

const TZ = "Europe/Chisinau";
const PROTOCOL = "2025-06-18";

// Дата и время по Кишинёву
const fmt = (iso) => new Date(iso).toLocaleString("ru-RU", { timeZone: TZ, dateStyle: "short", timeStyle: "short" });
// Дата по Кишинёву в виде YYYY-MM-DD
const dayOf = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);

const TOOLS = [
  {
    name: "leads_list",
    description: "Заявки CRM за период по дате создания (часовой пояс Кишинёва). Без дат — за сегодня.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Первый день периода, YYYY-MM-DD. По умолчанию сегодня." },
        to: { type: "string", description: "Последний день периода, YYYY-MM-DD. По умолчанию равен from." },
      },
    },
  },
  {
    name: "lead_find",
    description: "Найти клиента CRM по части имени или телефона.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Имя, фамилия или цифры телефона" } },
      required: ["query"],
    },
  },
  {
    name: "lead_set_stage",
    description: `Перевести клиента на другой этап воронки. Этапы: ${STATUSES.join(", ")}. Номер клиента можно узнать через lead_find.`,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer", description: "Номер клиента" },
        status: { type: "string", enum: STATUSES, description: "Новый этап" },
      },
      required: ["id", "status"],
    },
  },
];

const line = (l) =>
  `#${l.id} ${l.name} · ${l.phone || "без телефона"} · ${l.status} · ${l.source} · создан ${fmt(l.created_at)}`;

async function leadsList({ from, to }) {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  const start = from || dayOf(new Date());
  const end = to || start;
  if (!re.test(start) || !re.test(end) || end < start) throw new UserError("Даты нужны в виде YYYY-MM-DD, и to не раньше from.");

  // Берём с запасом в сутки по UTC, а точную границу считаем по Кишинёву
  const after = new Date(Date.parse(start + "T00:00:00Z") - 86400000).toISOString();
  const before = new Date(Date.parse(end + "T00:00:00Z") + 2 * 86400000).toISOString();
  const rows = await supabase(
    `leads?select=id,name,phone,status,source,created_at&created_at=gte.${after}&created_at=lt.${before}&order=created_at.desc`
  );
  const list = rows.filter((l) => { const d = dayOf(new Date(l.created_at)); return d >= start && d <= end; });

  const period = start === end ? start : `${start} — ${end}`;
  if (!list.length) return `За ${period} заявок нет.`;
  return [`За ${period} заявок: ${list.length}.`, ...list.map(line)].join("\n");
}

async function leadFind({ query }) {
  // Оставляем только буквы, цифры, пробел, «+» и «-»: остальное ломает синтаксис фильтра Supabase
  const q = String(query || "").replace(/[^\p{L}\p{N} +\-]/gu, "").trim().slice(0, 60);
  if (q.length < 2) throw new UserError("Нужно хотя бы 2 буквы или цифры.");
  const like = encodeURIComponent(`*${q}*`);
  const rows = await supabase(
    `leads?select=id,name,phone,status,source,created_at&or=(name.ilike.${like},phone.ilike.${like})&order=created_at.desc&limit=20`
  );
  if (!rows.length) return `По запросу «${q}» никого не нашлось.`;
  return [`Найдено: ${rows.length}.`, ...rows.map(line)].join("\n");
}

async function leadSetStage({ id, status }) {
  if (!Number.isInteger(id) || id < 1) throw new UserError("Нужен номер клиента (целое число).");
  if (!STATUSES.includes(status)) throw new UserError(`Неизвестный этап. Допустимые: ${STATUSES.join(", ")}.`);

  const [lead] = await supabase(`leads?id=eq.${id}&select=id,name,status`);
  if (!lead) throw new UserError(`Клиент #${id} не найден.`);
  if (lead.status === status) return `${lead.name} (#${id}) уже на этапе «${status}».`;

  try {
    await supabase(`leads?id=eq.${id}`, { method: "PATCH", body: { status } });
  } catch (err) {
    if (String(err.message).includes("_uniq")) {
      throw new UserError("Не получилось: время консультации или активная запись этого клиента пересекается с другой.");
    }
    throw err;
  }

  // Запись в истории создал триггер базы. Помечаем её, что смена пришла через MCP.
  const [last] = await supabase(`lead_stage_history?lead_id=eq.${id}&select=id&order=id.desc&limit=1`);
  if (last) await supabase(`lead_stage_history?id=eq.${last.id}`, { method: "PATCH", body: { note: "MCP" } });

  return `${lead.name} (#${id}): «${lead.status}» → «${status}». В истории отмечено «MCP».`;
}

class UserError extends Error {}

const HANDLERS = { leads_list: leadsList, lead_find: leadFind, lead_set_stage: leadSetStage };

function authorized(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return Boolean(token) && safeEqual(token, env("MCP_TOKEN"));
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!authorized(req)) return res.status(401).json({ error: "Нужен токен доступа" });

  // Сервер без потоков и сессий: только POST с JSON-RPC
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Метод не поддерживается" });
  }

  const msg = readBody(req);
  const reply = (result) => res.status(200).json({ jsonrpc: "2.0", id: msg.id, result });
  const fail = (code, message) => res.status(200).json({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });

  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return fail(-32600, "Неверный запрос");
  // Уведомления (без id) ответа не требуют
  if (msg.id === undefined) return res.status(202).end();

  switch (msg.method) {
    case "initialize":
      return reply({
        protocolVersion: msg.params?.protocolVersion || PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: "vydyhai-crm", version: "1.0.0" },
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      const fn = HANDLERS[msg.params?.name];
      if (!fn) return fail(-32602, "Нет такого инструмента");
      try {
        const text = await fn(msg.params.arguments || {});
        return reply({ content: [{ type: "text", text }] });
      } catch (err) {
        if (!(err instanceof UserError)) console.error(err);
        const text = err instanceof UserError ? err.message : "Ошибка сервера при работе с CRM";
        return reply({ content: [{ type: "text", text }], isError: true });
      }
    }
    default:
      return fail(-32601, "Метод не поддерживается");
  }
}
