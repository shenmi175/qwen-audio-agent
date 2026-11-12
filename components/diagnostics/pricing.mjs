const rates = {
  'qwen-audio-3.1-realtime-plus': [5, 40, 40, 150],
  'qwen-audio-3.0-realtime-plus': [5, 40, 40, 150],
  'qwen-audio-3.0-realtime-flash': [1.5, 6, 4.5, 12],
  'qwen3.5-omni-flash-realtime': [3.3, 27, 20, 107],
}
export function estimateUsageCost(model, region, usage) {
  const rate = rates[model]
  const input = usage?.input_tokens_details || usage?.input_token_details
  const output = usage?.output_tokens_details || usage?.output_token_details
  const source = 'https://help.aliyun.com/zh/model-studio/model-pricing'
  if (!rate || region !== 'beijing' || !input || !output)
    return { costStatus: 'unknown', costCurrency: 'CNY' }
  if (input.cached_tokens || input.image_tokens || input.video_tokens)
    return { costStatus: 'unknown', costCurrency: 'CNY' }
  const numbers = [
    input.text_tokens,
    input.audio_tokens,
    output.text_tokens,
    output.audio_tokens,
  ]
  if (numbers.some((n) => !Number.isFinite(n)))
    return { costStatus: 'unknown', costCurrency: 'CNY' }
  const [it, ia, ot, oa] = numbers
  // These verified models charge accompanying audio transcription only once.
  return {
    costStatus: 'estimated_cny',
    costCurrency: 'CNY',
    estimatedCostCny:
      (it * rate[0] +
        ia * rate[1] +
        (oa > 0 ? 0 : ot * rate[2]) +
        oa * rate[3]) /
      1e6,
    pricingSource: source,
    pricingVerifiedAt: '2026-11-12',
  }
}
