// 名乗りと、robots.txt の名前の組の表（段階3の設計の 1.7 の (2)。問1 の作者の答え: 名乗りを正直にし、断りをすり抜けない）。
// - 名乗り（User-Agent）はコネクタだと分かる名前だけ。ブラウザの名前を入れない・連絡先（メール・リポジトリの URL）を入れない
//   （作者の名前が外に出るため）。公開する形にまとめた中身にブラウザの名前が入っていない事は bundle-check で見る
// - Claude・Anthropic の名前の組（ANTHROPIC_AGENTS）は、どれか1つでも取りに行く道を断っていれば取らない（コネクタの名前を名指しで許す組が
//   ある時だけ取る）。Claude-User は Claude が人の代わりに取りに行く時の名前で、取った物は Claude に渡すので、これにも従う
// - ほかの AI の名前の組（AI_AGENTS）の断りは、取りを止めて作者に伺う（問1 の「AI・自動収集による取得や利用を断っている所からは取らない」を
//   名前の表に頼らずに守るため、robots.txt の注の AI の語・表に無い名前の新しい断りでも止める）
// - 表にある AI でない名前（OTHER_AGENTS）は、新しく足されても止めない（検索の名前など）。表は開発が足す

/** コネクタの名前（robots.txt の組の名前として名指しできる物） */
export const CONNECTOR_AGENT = 'TopicStudioConnector'

/** 取りに行く時の名乗り（User-Agent） */
export const USER_AGENT = `${CONNECTOR_AGENT}/1.0`

/** Claude が人の代わりに取りに行く時の名前 */
export const CLAUDE_USER_AGENT = 'Claude-User'

/** Claude・Anthropic の名前（どれか1つの組でも断れば取らない） */
export const ANTHROPIC_AGENTS: readonly string[] = [
  'ClaudeBot',
  'Claude-User',
  'Claude-Web',
  'Claude-SearchBot',
  'Claude-Code',
  'anthropic-ai',
]

/** ほかの AI の名前（断りが出たら取りを止めて作者に伺う。開発が足す） */
export const AI_AGENTS: readonly string[] = [
  'GPTBot',
  'ChatGPT-User',
  'OAI-SearchBot',
  'CCBot',
  'Google-Extended',
  'Google-CloudVertexBot',
  'Gemini-Deep-Research',
  'PerplexityBot',
  'Perplexity-User',
  'Bytespider',
  'Applebot-Extended',
  'meta-externalagent',
  'meta-externalfetcher',
  'FacebookBot',
  'cohere-ai',
  'cohere-training-data-crawler',
  'Amazonbot',
  'Diffbot',
  'Omgilibot',
  'omgili',
  'ImagesiftBot',
  'YouBot',
  'AI2Bot',
  'Ai2Bot-Dolma',
  'DuckAssistBot',
  'MistralAI-User',
  'Timpibot',
  'webzio-extended',
  'PanguBot',
  'TikTokSpider',
  'Kangaroo Bot',
  'ICC-Crawler',
  'img2dataset',
  'Scrapy',
]

/** AI でない、知っている名前（新しく足されても止めない） */
export const OTHER_AGENTS: readonly string[] = [
  'Googlebot',
  'Googlebot-Image',
  'Googlebot-News',
  'Googlebot-Video',
  'Mediapartners-Google',
  'AdsBot-Google',
  'AdsBot-Google-Mobile',
  'Storebot-Google',
  'GoogleOther',
  'bingbot',
  'msnbot',
  'BingPreview',
  'Slurp',
  'DuckDuckBot',
  'Baiduspider',
  'YandexBot',
  'Yandex',
  'Applebot',
  'Yeti',
  'Naverbot',
  'SeznamBot',
  'facebookexternalhit',
  'Twitterbot',
  'LinkedInBot',
  'Pinterestbot',
  'ia_archiver',
  'archive.org_bot',
  'AhrefsBot',
  'SemrushBot',
  'MJ12bot',
  'DotBot',
  'PetalBot',
  'Sogou web spider',
]

/**
 * 名前をそろえる（robots.txt の組の名前は大文字・小文字を区別しない。`ClaudeBot/1.0` のような版の書きは落とし、名前（RFC 9309 の
 * product token）で比べる）
 */
export const agentKey = (name: string): string => name.trim().toLowerCase().replace(/\/.*$/, '').trim()

const ANTHROPIC_KEYS: ReadonlySet<string> = new Set(ANTHROPIC_AGENTS.map(agentKey))
const AI_KEYS: ReadonlySet<string> = new Set(AI_AGENTS.map(agentKey))
const OTHER_KEYS: ReadonlySet<string> = new Set(OTHER_AGENTS.map(agentKey))

/** 名前の種類（connector = コネクタ・anthropic = Claude・Anthropic・ai = ほかの AI・other = 知っている AI でない名前・unknown = 表に無い） */
export type AgentKind = 'connector' | 'anthropic' | 'ai' | 'other' | 'unknown' | 'any'

/**
 * 名前の種類。表の名前と同じでなくても、Claude・Anthropic の語を含む名前（`Claude`・`ClaudeBot-Image` など）は Claude・Anthropic の名前に、
 * ほかの AI の名前を含む名前（`GPTBot-Image` など）はほかの AI の名前に読む（断る側・止める側に寄せる）
 */
export function agentKind(name: string): AgentKind {
  const k = agentKey(name)
  if (k === '*') return 'any'
  if (k === agentKey(CONNECTOR_AGENT)) return 'connector'
  if (ANTHROPIC_KEYS.has(k) || /claude|anthropic/.test(k)) return 'anthropic'
  if (AI_KEYS.has(k)) return 'ai'
  if (OTHER_KEYS.has(k)) return 'other'
  for (const a of AI_KEYS) if (k.includes(a)) return 'ai'
  return 'unknown'
}

/**
 * robots.txt の注（# の行）の AI・機械学習・学習・生成 AI・LLM・scraping などの語（出たら取りを止めて伺う）。
 * 英字の短い語（AI・LLM・TDM）は大文字・小文字を問わず、前後が英字でない時だけ（MAIL・DETAIL などに当てない）
 */
const COMMENT_WORDS: readonly RegExp[] = [
  /(?<![A-Za-z])(?:AI|A\.I\.|GenAI|LLMs?|TDM)(?![A-Za-z])/i,
  /\b(?:artificial intelligence|machine learning|deep learning|text and data mining|data mining|scrap(?:e|es|ed|er|ers|ing)|training data|model training|language models?)\b/i,
  /人工知能|機械学習|深層学習|生成\s*AI|生成AI|学習|スクレイピング|テキスト.?データ.?マイニング/,
]

/** 注の文に AI の語があるか */
export function hasAiWord(comment: string): boolean {
  const t = comment.normalize('NFKC')
  return COMMENT_WORDS.some((re) => re.test(t))
}
