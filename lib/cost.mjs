// Estimated cost of one call, from the token counts the provider reports and the prices in
// config.json. Tool calls (web searches) are priced per call when config.json gives a price;
// otherwise they are counted but left out of the dollar figure, and the result says so.
export function estimateCost(usage, model, cfg) {
  const p = model.price ?? {};
  const connectorAsInput = cfg.connectorTokens === 'input';
  const tokens =
    ((usage.inputTokens ?? 0) + (connectorAsInput ? usage.connectorTokens ?? 0 : 0)) * (p.inputPerM ?? 0) / 1e6 +
    (usage.outputTokens ?? 0) * (p.outputPerM ?? 0) / 1e6;
  let tools = 0;
  const unpriced = [];
  for (const [name, n] of Object.entries(usage.toolCalls ?? {})) {
    const price = cfg.tools?.[name]?.pricePerCall;
    if (typeof price === 'number') tools += n * price;
    else if (n) unpriced.push(name);
  }
  return { tokens, tools, total: tokens + tools, unpriced };
}

export function sumUsage(calls) {
  const s = { inputTokens: 0, outputTokens: 0, connectorTokens: 0, toolCalls: {}, cost: 0, unpriced: new Set() };
  for (const c of calls) {
    s.inputTokens += c.usage.inputTokens ?? 0;
    s.outputTokens += c.usage.outputTokens ?? 0;
    s.connectorTokens += c.usage.connectorTokens ?? 0;
    for (const [k, v] of Object.entries(c.usage.toolCalls ?? {})) s.toolCalls[k] = (s.toolCalls[k] ?? 0) + v;
    s.cost += c.cost.total;
    for (const u of c.cost.unpriced ?? []) s.unpriced.add(u);
  }
  return { ...s, unpriced: [...s.unpriced] };
}
