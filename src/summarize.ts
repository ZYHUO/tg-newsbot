import { config } from './config.js'

export interface Summary {
  /** 标题（中文，原文是中文则照搬，英文则翻译） */
  titleZh: string
  /** 2-3 句中文摘要 */
  summaryZh: string
  /** true = 广告/招聘/抽奖等垃圾，不发 */
  skip: boolean
  /** 1-5，5 = 重大新闻（加 ⚡ 标记），仅作展示 */
  importance: number
}

/** Tolerant JSON extraction: strips code fences, grabs outermost braces. */
export function salvageJson(raw: string): unknown {
  let s = raw.trim()
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) throw new Error('no JSON object in LLM output')
  return JSON.parse(s.slice(start, end + 1))
}

const SYSTEM = `你是一个新闻编辑，为 Telegram 中文资讯频道处理新闻条目。给你一条新闻的标题和摘录，你输出 JSON（不要 markdown 代码块，直接输出 JSON）：
{
  "title_zh": "标题的中文版（原文是中文则原样保留；英文则翻译成自然的中文，保留关键专有名词原文如 OpenAI、GPT-5）",
  "summary_zh": "2-3 句中文摘要，说清楚发生了什么、为什么值得关注。基于给到的信息写，不要编造细节。",
  "skip": false,
  "importance": 3
}
规则：
- skip=true 的情况：纯广告/促销、招聘启事、抽奖活动、播客/直播预告、单纯的产品打折信息、与新闻无关的内容
- importance: 1=边角料 2=一般 3=值得一看 4=重要 5=重大（如重要模型发布、重大漏洞、重大收购、战争级时事）
- 摘要里不要出现"本文""文章称"这种字眼，直接陈述事实`

export async function summarize(
  title: string,
  excerpt: string,
  source: string,
  category: string,
): Promise<Summary> {
  const res = await fetch(`${config.llm.endpoint}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(config.llm.apiKey ? { authorization: `Bearer ${config.llm.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: config.llm.model,
      messages: [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content: `来源: ${source}（分类 ${category}）\n标题: ${title}\n摘录: ${excerpt || '（无）'}`,
        },
      ],
      temperature: 0.3,
      max_tokens: 600,
    }),
    signal: AbortSignal.timeout(config.llm.timeoutMs),
  })
  if (!res.ok) {
    throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 200)}`)
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
  const content = data.choices?.[0]?.message?.content
  if (!content) throw new Error('LLM returned empty content')
  const j = salvageJson(content) as Record<string, unknown>
  return {
    titleZh: String(j.title_zh ?? title).trim() || title,
    summaryZh: String(j.summary_zh ?? '').trim(),
    skip: j.skip === true,
    importance: Math.min(5, Math.max(1, Number(j.importance) || 3)),
  }
}
