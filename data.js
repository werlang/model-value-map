/**
 * Static snapshot joined from two public sources (retrieved 2026-08-23):
 *
 * - X axis · ocCostPerM: USD per 1M tokens, from opencode.ai/data
 *   ("Token Cost" board; where the board omits a model, its published
 *   output rate from the model's own opencode.ai/data page is used).
 * - Y axis · aa.intelligenceIndex: Artificial Analysis Intelligence
 *   Index v4.1.1, from artificialanalysis.ai/models (incl. per-model pages).
 *
 * Models missing one of the two metrics carry plot:false and an
 * excludeReason so the UI can show them honestly instead of dropping them.
 */
window.DASHBOARD_DATA = {
  meta: {
    retrieved: '2026-08-23',
    opencodeUpdated: '2026-08-23T19:39:11Z',
    aaIndex: 'Artificial Analysis Intelligence Index v4.1.1',
    sources: [
      { name: 'opencode.ai/data', url: 'https://opencode.ai/data' },
      { name: 'artificialanalysis.ai/models', url: 'https://artificialanalysis.ai/models' },
    ],
  },
  models: [
    {
      id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', author: 'DeepSeek', hue: '#3B5BDB',
      rank: 1, weeklyTokensT: 39.99, ocCostPerM: 0.28,
      ocCost: { input: 0.14, output: 0.28, cached: 0.028 },
      reasoning: true, openWeights: true, contextWindowTokens: 1000000,
      aa: { name: 'DeepSeek V4 Flash 0731 (max)', intelligenceIndex: 51.77, effort: 'max',
            url: 'https://artificialanalysis.ai/models/deepseek-v4-flash' },
      plot: true,
    },
    {
      id: 'ox-alpha', label: 'Ox-Alpha', author: 'Unknown', hue: '#8B94A3',
      rank: 2, weeklyTokensT: 17.68, ocCostPerM: null, ocCost: null,
      reasoning: null, openWeights: null, contextWindowTokens: null,
      aa: null, plot: false, excludeReason: 'No token cost published on OpenCode; not scored by Artificial Analysis.',
    },
    {
      id: 'mimo-v2.5', label: 'MiMo-V2.5', author: 'Xiaomi', hue: '#D9480F',
      rank: 3, weeklyTokensT: 12.61, ocCostPerM: 0.28,
      ocCost: { input: 0.14, output: 0.28, cached: 0.003 },
      reasoning: true, openWeights: true, contextWindowTokens: 1000000,
      aa: { name: 'MiMo-V2.5', intelligenceIndex: 38.04, effort: null,
            url: 'https://artificialanalysis.ai/models/mimo-v2-5-0424' },
      plot: true,
    },
    {
      id: 'muse-spark-1.2-contributor', label: 'Muse Spark 1.2 (contrib)', author: 'Meta', hue: '#1971C2',
      rank: 4, weeklyTokensT: 5.6, ocCostPerM: null, ocCost: null,
      reasoning: true, openWeights: false, contextWindowTokens: 1048576,
      aa: { name: 'Muse Spark 1.2 (xhigh)', intelligenceIndex: 56.76, effort: 'xhigh',
            url: 'https://artificialanalysis.ai/models/muse-spark-1-2' },
      plot: false, excludeReason: 'No token cost published on OpenCode.',
    },
    {
      id: 'nemotron-3-ultra', label: 'Nemotron 3 Ultra', author: 'NVIDIA', hue: '#2F9E44',
      rank: 5, weeklyTokensT: 3.1, ocCostPerM: null, ocCost: null,
      reasoning: true, openWeights: true, contextWindowTokens: null,
      aa: { name: 'Nemotron 3 Ultra', intelligenceIndex: 38.32, effort: null,
            url: 'https://artificialanalysis.ai/models/nvidia-nemotron-3-ultra-550b-a55b' },
      plot: false, excludeReason: 'No token cost published on OpenCode.',
    },
    {
      id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', author: 'DeepSeek', hue: '#3B5BDB',
      rank: 6, weeklyTokensT: 2.95, ocCostPerM: 3.2,
      ocCost: { input: 1.6, output: 3.2, cached: 0.135 },
      reasoning: true, openWeights: true, contextWindowTokens: null,
      aa: { name: 'DeepSeek V4 Pro 0813 (max)', intelligenceIndex: 53.2, effort: 'max',
            url: 'https://artificialanalysis.ai/models/deepseek-v4-pro' },
      plot: true,
    },
    {
      id: 'hy3', label: 'Hy3', author: 'Tencent', hue: '#E8890C',
      rank: 7, weeklyTokensT: 1.9, ocCostPerM: 0.528,
      ocCost: { input: 0.132, output: 0.528, cached: 0.033 },
      reasoning: true, openWeights: true, contextWindowTokens: 256000,
      aa: { name: 'Hy3', intelligenceIndex: 42.21, effort: null,
            url: 'https://artificialanalysis.ai/models/hy3' },
      plot: true,
    },
    {
      id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', author: 'OpenAI', hue: '#0C8599',
      rank: 8, weeklyTokensT: 1.6, ocCostPerM: 1.2,
      ocCost: { input: 0.2, output: 1.2, cached: 0.02 },
      reasoning: true, openWeights: false, contextWindowTokens: null,
      aa: { name: 'GPT-5.6 Luna (max)', intelligenceIndex: 52.32, effort: 'max',
            url: 'https://artificialanalysis.ai/models/gpt-5-6-luna' },
      plot: true,
    },
    {
      id: 'nemotron-3.5-lightning', label: 'Nemotron 3.5 Lightning', author: 'NVIDIA', hue: '#2F9E44',
      rank: 9, weeklyTokensT: 0.78, ocCostPerM: 0.2,
      ocCost: { input: 0.08, output: 0.2, cached: 0.04 },
      reasoning: true, openWeights: true, contextWindowTokens: null,
      aa: null, plot: false, excludeReason: 'Not scored on the Artificial Analysis Intelligence Index yet.',
    },
    {
      id: 'deepseek-v4-flash-vision-exp', label: 'DS V4 Flash Vision Exp', author: 'DeepSeek', hue: '#3B5BDB',
      rank: 10, weeklyTokensT: 0.61, ocCostPerM: 0.66,
      ocCost: { input: 0.22, output: 0.66, cached: 0.007 },
      reasoning: true, openWeights: true, contextWindowTokens: null,
      aa: null, plot: false, excludeReason: 'Not scored on the Artificial Analysis Intelligence Index yet.',
    },
    {
      id: 'minimax-m3', label: 'MiniMax-M3', author: 'MiniMax', hue: '#C2255C',
      rank: 11, weeklyTokensT: 0.54, ocCostPerM: 1.2,
      ocCost: { input: 0.3, output: 1.2, cached: 0.06 },
      reasoning: true, openWeights: true, contextWindowTokens: null,
      aa: { name: 'MiniMax-M3', intelligenceIndex: 45.4, effort: null,
            url: 'https://artificialanalysis.ai/models/minimax-m3' },
      plot: true,
    },
    {
      id: 'glm-5.2', label: 'GLM-5.2', author: 'Zhipu', hue: '#0CA678',
      rank: 12, weeklyTokensT: 0.46, ocCostPerM: 4.4,
      ocCost: { input: 1.4, output: 4.4, cached: 0.26 },
      reasoning: true, openWeights: true, contextWindowTokens: null,
      aa: { name: 'GLM-5.2 (max)', intelligenceIndex: 52.64, effort: 'max',
            url: 'https://artificialanalysis.ai/models/glm-5-2' },
      plot: true,
    },
    {
      id: 'glm-5.3', label: 'GLM-5.3', author: 'Zhipu', hue: '#0CA678',
      rank: 13, weeklyTokensT: 0.43, ocCostPerM: 4.4,
      ocCost: { input: 1.4, output: 4.4, cached: 0.26 },
      reasoning: true, openWeights: false, contextWindowTokens: null,
      aa: { name: 'GLM-5.3 (max)', intelligenceIndex: 59.51, effort: 'max',
            url: 'https://artificialanalysis.ai/models/glm-5-3' },
      plot: true,
    },
    {
      id: 'laguna-s-2.1', label: 'Laguna-S 2.1', author: 'Unknown', hue: '#8B94A3',
      rank: 14, weeklyTokensT: 0.33, ocCostPerM: 0.2,
      ocCost: { input: 0.1, output: 0.2, cached: 0.01 },
      reasoning: null, openWeights: null, contextWindowTokens: 1048576,
      aa: null, plot: false, excludeReason: 'Not scored on the Artificial Analysis Intelligence Index yet.',
    },
    {
      id: 'mimo-v2.5-pro', label: 'MiMo-V2.5-Pro', author: 'Xiaomi', hue: '#D9480F',
      rank: 15, weeklyTokensT: 0.33, ocCostPerM: 0.87,
      ocCost: { input: 0.435, output: 0.87, cached: null },
      reasoning: true, openWeights: true, contextWindowTokens: 1048576,
      aa: { name: 'MiMo-V2.5-Pro', intelligenceIndex: 42.88, effort: null,
            url: 'https://artificialanalysis.ai/models/mimo-v2-5-pro' },
      plot: true,
    },
    {
      id: 'kimi-k2.7-code', label: 'Kimi K2.7 Code', author: 'Moonshot', hue: '#9C36B5',
      rank: 16, weeklyTokensT: 0.26, ocCostPerM: 4,
      ocCost: { input: 0.95, output: 4, cached: null },
      reasoning: true, openWeights: true, contextWindowTokens: null,
      aa: { name: 'Kimi K2.7 Code', intelligenceIndex: 43.02, effort: null,
            url: 'https://artificialanalysis.ai/models/kimi-k2-7-code' },
      plot: true,
    },
    {
      id: 'kimi-k3', label: 'Kimi K3', author: 'Moonshot', hue: '#9C36B5',
      rank: 17, weeklyTokensT: 0.21, ocCostPerM: 15,
      ocCost: { input: 3, output: 15, cached: 0.3 },
      reasoning: true, openWeights: true, contextWindowTokens: 1048576,
      aa: { name: 'Kimi K3 (max)', intelligenceIndex: 59.7, effort: 'max',
            url: 'https://artificialanalysis.ai/models/kimi-k3' },
      plot: true,
    },
    {
      id: 'qwen3.7-plus', label: 'Qwen3.7 Plus', author: 'Qwen', hue: '#6741D9',
      rank: 18, weeklyTokensT: 0.19, ocCostPerM: 1.6,
      ocCost: { input: 0.4, output: 1.6, cached: null },
      reasoning: true, openWeights: true, contextWindowTokens: null,
      aa: { name: 'Qwen3.7 Plus', intelligenceIndex: 39.37, effort: null,
            url: 'https://artificialanalysis.ai/models/qwen3-7-plus' },
      plot: true,
    },
  ],
};
