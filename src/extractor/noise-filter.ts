/**
 * graph-memory — Input Layer Noise Filter
 *
 * 在 LLM 提取之前过滤无效消息（Agent 拒绝回复、元问题、Boilerplate）。
 * 参考 memory-lancedb-pro 的 noise-filter 设计。
 */

// ─── Denial Patterns ─────────────────────────────────────────────

const DENIAL_PATTERNS = [
  // English denials (agent-side)
  /i don'?t have (any )?(information|data|memory|record)/i,
  /i'?m not sure about/i,
  /i don'?t recall/i,
  /i don'?t remember/i,
  /it looks like i don'?t/i,
  /i wasn'?t able to find/i,
  /no (relevant )?memories found/i,
  /i don'?t have access to/i,
  // Chinese denials (agent-side)
  /我没有(任何)?(相关)?(信息|数据|记忆|记录)/,
  /我不(太)?确定/,
  /我不记得/,
  /我想不起来/,
  /我没(有)?找到/,
  /找不到(相关)?记忆/,
  /没有(相关)?记忆/,
  /我无法(访问|获取)/,
];

// ─── Meta-question Patterns ──────────────────────────────────────

const META_QUESTION_PATTERNS = [
  // English meta-questions (user-side, about memory)
  /\bdo you (remember|recall|know about)\b/i,
  /\bcan you (remember|recall)\b/i,
  /\bdid i (tell|mention|say|share)\b/i,
  /\bhave i (told|mentioned|said)\b/i,
  /\bwhat did i (tell|say|mention)\b/i,
  // Chinese meta-questions (user-side, about memory)
  /你(还)?记得吗/,
  /你(还)?记不记得/,
  /你知道我(说过|提过|告诉|提到).*吗/,
  /我(有没有|是不是)(说过|提过|告诉|提到)/,
  /我之前(说过|提过|提到|告诉)/,
  /我(跟你)?说过.*吗/,
];

// ─── Boilerplate Patterns ───────────────────────────────────────

/** 头尾严格的 boilerplate，只匹配纯招呼语 */
const STRICT_BOILERPLATE_PATTERNS = [
  /^(hi|hello|hey|good morning|good evening|greetings|yo|sup|howdy)/i,
  /^fresh session/i,
  /^new session/i,
  /^HEARTBEAT/i,
  // Chinese strict (头尾严格，防止误匹配)
  /^你好[!！\s,.，。]?$/,
  /^(早上好|早安|午安|晚上好|晚安)[!！\s,.，。]?$/,
  /^(嗨|哈[喽啰]|哈[喽啰]呀)[!！\s,.，。]?$/,
  /^新(会话|对话|聊天)/,
];

// ─── Short Boilerplate (长度阈值) ───────────────────────────────

/**
 * 短文本 boilerplate 前缀模式。
 * 只有当文本总长度 ≤ BOILERPLATE_MAX_LENGTH 时才视为噪声，
 * 避免误杀有实质内容的正文。
 *
 * 例如：
 *   "好的"                    → 噪声 (2 ≤ 10)
 *   "好的方案是用Redis缓存"    → 不过滤 (有实质后续内容)
 *   "谢谢你的帮助"            → 噪声 (6 ≤ 10)
 *   "谢谢分享，这个思路很好"  → 不过滤 (有实质后续内容)
 */
const SHORT_BOILERPLATE_PATTERNS = [
  /^(好的|好吧|行|可以|没问题|ok|ok|收到|明白|了解|知道了)/i,
  /^(谢谢|感谢|多谢|谢啦|3q|thx)/i,
];

/** 短 boilerplate 最大长度阈值 */
const BOILERPLATE_MAX_LENGTH = 10;

// ─── Core Filter ────────────────────────────────────────────────

/**
 * 判断一段文本是否为噪声。
 * 返回 true = 噪声，应过滤；false = 有效，应保留。
 */
export function isNoise(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 3) return true;

  // Denial
  if (DENIAL_PATTERNS.some(p => p.test(trimmed))) return true;

  // Meta-question about memory
  if (META_QUESTION_PATTERNS.some(p => p.test(trimmed))) return true;

  // Strict boilerplate（头尾严格的招呼语）
  if (STRICT_BOILERPLATE_PATTERNS.some(p => p.test(trimmed))) return true;

  // Short boilerplate（总长度 ≤ 阈值时才视为噪声）
  if (trimmed.length <= BOILERPLATE_MAX_LENGTH) {
    if (SHORT_BOILERPLATE_PATTERNS.some(p => p.test(trimmed))) return true;
  }

  return false;
}

/**
 * 对消息数组应用 input-layer noise filter。
 * 返回过滤后的消息（保留所有字段，只过滤内容）。
 *
 * @param messages 原始消息数组
 * @param getText 从消息中提取纯文本的函数
 */
export function filterNoiseMessages<T>(messages: T[], getText: (msg: T) => string): T[] {
  return messages.filter(msg => !isNoise(getText(msg)));
}
