const DEFAULT_PRICE_INPUT_USD_PER_1M = Number(process.env.OPENAI_INPUT_PRICE_PER_1M || 0);
const DEFAULT_PRICE_OUTPUT_USD_PER_1M = Number(process.env.OPENAI_OUTPUT_PRICE_PER_1M || 0);

function safeNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function estimateTokensFromText(value) {
  if (!value) return 0;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Math.max(1, Math.ceil(text.length / 4));
}

function estimateInputTokens(input) {
  if (Array.isArray(input)) {
    return input.reduce((total, item) => total + estimateTokensFromText(item?.content || item), 0);
  }

  return estimateTokensFromText(input);
}

function readUsage(response, input, outputText) {
  const usage = response?.usage || {};

  const inputTokens = safeNumber(
    usage.input_tokens ?? usage.prompt_tokens,
    estimateInputTokens(input)
  );

  const outputTokens = safeNumber(
    usage.output_tokens ?? usage.completion_tokens,
    estimateTokensFromText(outputText)
  );

  const totalTokens = safeNumber(
    usage.total_tokens,
    inputTokens + outputTokens
  );

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    source: response?.usage ? "api" : "estimation"
  };
}

function buildCost(usage, prices = {}) {
  const inputPrice = safeNumber(prices.inputPricePer1M, DEFAULT_PRICE_INPUT_USD_PER_1M);
  const outputPrice = safeNumber(prices.outputPricePer1M, DEFAULT_PRICE_OUTPUT_USD_PER_1M);

  const inputCostUsd = (usage.input_tokens / 1_000_000) * inputPrice;
  const outputCostUsd = (usage.output_tokens / 1_000_000) * outputPrice;
  const totalCostUsd = inputCostUsd + outputCostUsd;

  return {
    input_price_per_1m_usd: inputPrice,
    output_price_per_1m_usd: outputPrice,
    input_cost_usd: Number(inputCostUsd.toFixed(8)),
    output_cost_usd: Number(outputCostUsd.toFixed(8)),
    total_cost_usd: Number(totalCostUsd.toFixed(8))
  };
}

async function saveUsageEvent({ supabase, event }) {
  if (!supabase) return;

  try {
    await supabase.from("openai_usage_events").insert([event]);
  } catch (error) {
    console.warn("[OPENAI_USAGE] Sauvegarde ignorée :", error?.message || error);
  }
}

export async function createTrackedOpenAIResponse({
  openai,
  supabase,
  feature,
  model,
  input,
  responseOptions = {},
  metadata = {},
  prices = {}
}) {
  if (!openai) {
    throw new Error("Client OpenAI manquant");
  }

  const startedAt = Date.now();

  const response = await openai.responses.create({
    model,
    input,
    ...responseOptions
  });

  const durationMs = Date.now() - startedAt;
  const outputText = response?.output_text || "";
  const usage = readUsage(response, input, outputText);
  const cost = buildCost(usage, prices);

  const event = {
    feature: feature || "unknown",
    model,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens,
    usage_source: usage.source,
    input_price_per_1m_usd: cost.input_price_per_1m_usd,
    output_price_per_1m_usd: cost.output_price_per_1m_usd,
    input_cost_usd: cost.input_cost_usd,
    output_cost_usd: cost.output_cost_usd,
    total_cost_usd: cost.total_cost_usd,
    duration_ms: durationMs,
    metadata
  };

  console.log("[OPENAI_USAGE]", JSON.stringify(event));
  await saveUsageEvent({ supabase, event });

  return {
    response,
    outputText,
    usage,
    cost,
    durationMs
  };
}

export function getOpenAIUsageSql() {
  return `
create table if not exists openai_usage_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  feature text not null default 'unknown',
  model text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  total_tokens integer not null default 0,
  usage_source text not null default 'estimation',
  input_price_per_1m_usd numeric not null default 0,
  output_price_per_1m_usd numeric not null default 0,
  input_cost_usd numeric not null default 0,
  output_cost_usd numeric not null default 0,
  total_cost_usd numeric not null default 0,
  duration_ms integer not null default 0,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists openai_usage_events_created_at_idx
on openai_usage_events (created_at desc);

create index if not exists openai_usage_events_feature_idx
on openai_usage_events (feature);
`;
}
