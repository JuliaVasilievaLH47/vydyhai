// Создаёт или обновляет голосового агента «Выдыхай» в ElevenLabs Agents (блок 4 ДЗ №3).
// Запуск из папки проекта:  node scripts/voice-agent.mjs          — создать или обновить агента
//                           node scripts/voice-agent.mjs --show   — показать текущие настройки агента
//                           node scripts/voice-agent.mjs --voices — список доступных голосов
// Ключи берутся из .env: ELEVENLABS_API_KEY (ключ ElevenLabs) и VOICE_SECRET (тот же, что в Vercel).
// ID агента, инструментов и секрета (это не сами секреты) хранятся в scripts/voice-agent.ids.json.
// Папка scripts не публикуется на сайте (.vercelignore).
import fs from "node:fs";

process.loadEnvFile(".env");
const API = "https://api.elevenlabs.io";
const KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_SECRET = process.env.VOICE_SECRET;
const IDS_FILE = new URL("./voice-agent.ids.json", import.meta.url);
const SITE = "https://vydyhai.vercel.app";
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "cgSgspJ2msm6clMCkdW9"; // Jessica: молодой женский голос

if (!KEY) throw new Error("Впишите ELEVENLABS_API_KEY в .env");
if (!VOICE_SECRET) throw new Error("В .env нет VOICE_SECRET");

async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { "xi-api-key": KEY, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

const ids = fs.existsSync(IDS_FILE) ? JSON.parse(fs.readFileSync(IDS_FILE, "utf8")) : {};
const saveIds = () => fs.writeFileSync(IDS_FILE, JSON.stringify(ids, null, 2) + "\n");

// ---------- Разделы сайта. Тот же список — в SECTIONS в index.html ----------
const SECTIONS = {
  top: "начало страницы",
  inside: "«Что внутри»: состав вейпа и сигареты",
  brain: "«Мозг»: как никотин влияет на мозг подростка",
  timeline: "«Машина времени»: что будет через 1, 5 и 10 лет, калькулятор трат",
  look: "«Внешность»: кожа, зубы, волосы, запах, спорт",
  memes: "«Мемы»",
  myths: "«Мифы и факты»",
  quit: "«Хорошие новости»: как тело восстанавливается после отказа",
  help: "«Помощь»: телефоны горячих линий и запись к врачу или психологу (это и есть контакты)",
};

const PROMPT = `Ты — голосовой помощник сайта «Выдыхай». Это информационный проект для подростков о вреде сигарет и вейпов. Сайт помогает бесплатно записаться к врачу или психологу.

# Как говорить
- Обращайся на «ты». Говори дружелюбно, без нотаций и запугивания.
- Отвечай коротко: 1–3 предложения. Речь — не текст: без списков и ссылок.
- Говори только по-русски.
- Опирайся только на факты ниже. Если ответа нет в фактах, так и скажи и предложи записаться к специалисту.
- Ты не врач. Не ставь диагнозов и не советуй лекарства. По здоровью предлагай консультацию врача.

# Факты о проекте
- Консультации врача и психолога и семинары бесплатные. Цен и платных услуг нет.
- Врач: как бросить без мучений, что с лёгкими и сердцем, нужны ли анализы.
- Психолог: тяга, стресс, компания, давление сверстников. Анонимно, родителям не сообщаем без согласия подростка.
- Семинар: встреча в школе или онлайн, разбираем мифы, отвечаем на вопросы.
- После заявки с человеком связываются в течение суток. Заявку можно оставить за себя, за друга или как родитель. Если человеку меньше 14 лет, заявку оставляет родитель.
- Телефоны: 0 800 10001 — зелёная линия Минздрава Молдовы, помощь в отказе от курения, бесплатно. 116 111 — Telefonul Copilului, психологическая помощь детям и подросткам, круглосуточно, бесплатно и анонимно. 112 — экстренная служба.
- Продажа табака и никотина лицам до 18 лет в Молдове запрещена.
- Факты с сайта: мозг взрослеет до 25 лет, и никотин мешает ему. Одна сигарета в среднем отнимает 20 минут жизни. В табачном дыме около 7000 веществ, около 70 из них вызывают рак. Подростки, которые вейпят, примерно втрое чаще начинают курить сигареты. Пар вейпа — это аэрозоль с никотином, металлами и частицами, а не вода. Зависимость появляется уже через несколько недель. Через 20 минут после последней сигареты пульс и давление приходят в норму, через год риск болезней сердца снижается вдвое.

# Разговор не по теме
Если спрашивают о другом (уроки, игры, политика, погода и так далее), вежливо скажи, что ты помогаешь только по теме сайта, и предложи вопрос по теме или запись к специалисту.

# Если человеку плохо прямо сейчас
Если человек говорит, что ему очень плохо, страшно или он в опасности, сразу назови 112 и 116 111 и предложи позвонить туда.

# Показ разделов сайта
Когда просят что-то показать или спрашивают о теме, для которой есть раздел, вызови инструмент show_section. Затем скажи, что показываешь, и продолжай разговор.
Разделы на сайте:
${Object.entries(SECTIONS).map(([id, title]) => `- ${id}: ${title}`).join("\n")}
Если просят «контакты» или «телефоны», показывай help. Если спрашивают «цены», скажи, что всё бесплатно, а раздела с ценами нет.
Если просят раздел, которого нет в списке (например, отзывы, работы, команда, блог, магазин), не вызывай инструмент. Скажи, что такого раздела на сайте нет, и назови два-три похожих раздела из списка.

# Заявка
Когда человек хочет записаться или просит перезвонить:
1. Узнай имя.
2. Узнай телефон. Повтори номер по цифрам и попроси подтвердить.
3. Узнай, что нужно: врач, психолог, семинар или просто перезвонить.
4. Спроси возраст. Если меньше 14 лет, попроси, чтобы заявку оставил родитель, и не отправляй её.
5. Спроси согласие: «Ты согласен, чтобы мы использовали твой номер только для связи с тобой?» Без явного «да» заявку не отправляй.
6. Вызови инструмент create_lead. В summary кратко, в 1–3 предложениях, перескажи, о чём был разговор и что беспокоит человека.
7. Если инструмент ответил ok: true, скажи, что заявка принята и с ним свяжутся в течение суток. Если ответил ok: false, выполни то, что написано в error.`;

const FIRST_MESSAGE = "Привет! Я голосовой помощник «Выдыхай». Могу рассказать про вейпы и сигареты, показать нужный раздел сайта или записать тебя к врачу или психологу. С чего начнём?";

// ---------- Инструменты ----------
const showSectionTool = {
  type: "client",
  name: "show_section",
  description: "Прокручивает сайт к разделу. Вызывай, когда посетитель просит показать раздел или тему, для которой есть раздел.",
  expects_response: true,
  response_timeout_secs: 5,
  parameters: {
    type: "object",
    required: ["section"],
    properties: {
      section: {
        type: "string",
        enum: Object.keys(SECTIONS),
        description: "Идентификатор раздела: " + Object.entries(SECTIONS).map(([id, t]) => `${id} — ${t}`).join("; "),
      },
    },
  },
};

const createLeadTool = (secretId) => ({
  type: "webhook",
  name: "create_lead",
  description: "Создаёт заявку в CRM. Вызывай только после того, как узнал имя, подтверждённый телефон, что нужно, возраст от 14 лет и получил согласие.",
  response_timeout_secs: 20,
  api_schema: {
    url: SITE + "/api/voice-lead",
    method: "POST",
    request_headers: { "X-Voice-Secret": { secret_id: secretId } },
    request_body_schema: {
      type: "object",
      required: ["name", "phone", "topic", "consent", "summary"],
      properties: {
        name: { type: "string", description: "Как обращаться к посетителю" },
        phone: { type: "string", description: "Телефон, подтверждённый посетителем, только цифры и знак +" },
        topic: { type: "string", enum: ["Врач", "Психолог", "Семинар", "Перезвонить"], description: "Что нужно посетителю" },
        age: { type: "integer", description: "Возраст посетителя, если он его назвал" },
        consent: { type: "boolean", description: "true, только если посетитель явно согласился на обработку контактов" },
        summary: { type: "string", description: "Краткое содержание разговора в 1–3 предложениях" },
      },
    },
  },
});

// ---------- Секрет в сейфе ElevenLabs ----------
async function ensureSecret() {
  if (ids.secret_id) return ids.secret_id;
  const created = await api("POST", "/v1/convai/secrets", { type: "new", name: "vydyhai_voice_secret", value: VOICE_SECRET });
  ids.secret_id = created.secret_id;
  saveIds();
  return ids.secret_id;
}

async function upsertTool(key, config) {
  if (ids[key]) {
    await api("PATCH", `/v1/convai/tools/${ids[key]}`, { tool_config: config });
  } else {
    const created = await api("POST", "/v1/convai/tools", { tool_config: config });
    ids[key] = created.id;
    saveIds();
  }
  return ids[key];
}

function agentBody(toolIds) {
  return {
    name: "Выдыхай — голосовой помощник",
    conversation_config: {
      agent: {
        first_message: FIRST_MESSAGE,
        language: "ru",
        prompt: { prompt: PROMPT, tool_ids: toolIds },
      },
      // Ограничение длительности разговора: 3 минуты
      conversation: { max_duration_seconds: 180 },
      tts: { voice_id: VOICE_ID },
    },
    platform_settings: {
      // Виджет работает только на нашем сайте и на локальном сервере
      auth: { enable_auth: false, require_origin_header: true, allowlist: [{ hostname: "vydyhai.vercel.app" }, { hostname: "localhost" }] },
      // Не больше 10 разговоров в сутки и 2 одновременно — чтобы посторонние не потратили все минуты
      call_limits: { agent_concurrency_limit: 2, daily_limit: 10, bursting_enabled: false },
      widget: {
        variant: "compact",
        placement: "bottom-right",
        action_text: "Поговорить",
        start_call_text: "Начать разговор",
        end_call_text: "Закончить",
        listening_text: "Слушаю",
        speaking_text: "Говорю",
      },
    },
  };
}

const arg = process.argv[2];
if (arg === "--voices") {
  const { voices } = await api("GET", "/v2/voices?page_size=100");
  for (const v of voices) console.log(v.voice_id, "|", v.name, "|", JSON.stringify(v.labels || {}));
} else if (arg === "--show") {
  if (!ids.agent_id) throw new Error("Агент ещё не создан");
  console.log(JSON.stringify(await api("GET", `/v1/convai/agents/${ids.agent_id}`), null, 2));
} else {
  const secretId = await ensureSecret();
  const toolIds = [await upsertTool("show_section_tool_id", showSectionTool), await upsertTool("create_lead_tool_id", createLeadTool(secretId))];
  const body = agentBody(toolIds);
  if (ids.agent_id) {
    await api("PATCH", `/v1/convai/agents/${ids.agent_id}`, body);
    console.log("Агент обновлён:", ids.agent_id);
  } else {
    const created = await api("POST", "/v1/convai/agents/create", body);
    ids.agent_id = created.agent_id;
    saveIds();
    console.log("Агент создан:", ids.agent_id);
  }
}
