import json
import os
import re

import requests
from dotenv import load_dotenv

load_dotenv()

API_KEY = os.getenv("DEEPSEEK_API_KEY")
API_URL = os.getenv("DEEPSEEK_API_URL", "https://api.deepseek.com/v1/chat/completions")
MODEL = os.getenv("DEEPSEEK_MODEL", "deepseek-chat")


def _extract_json(text: str):
    match = re.search(r"```json\s*([\s\S]*?)```", text)
    if match:
        text = match.group(1)

    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise ValueError("AI 没有返回 JSON")

    return json.loads(text[start : end + 1])


def _normalize_result(result: dict, raw: str):
    graph = result.get("graph") or {}
    return {
        "summary": str(result.get("summary") or "").strip(),
        "characters": result.get("characters") if isinstance(result.get("characters"), list) else [],
        "foreshadowing": result.get("foreshadowing") if isinstance(result.get("foreshadowing"), list) else [],
        "terms": result.get("terms") if isinstance(result.get("terms"), list) else [],
        "graph": {
            "nodes": graph.get("nodes") if isinstance(graph.get("nodes"), list) else [],
            "edges": graph.get("edges") if isinstance(graph.get("edges"), list) else [],
        },
        "raw": raw,
    }


SUMMARY_RULES = {
    "brief": "summary 用 160-240 字概括本章信息，突出事件结果和读者最该记住的 2-3 个点。",
    "standard": "summary 用 350-550 字概括本章信息，要覆盖事件推进、人物动机、关键信息增量和读者需要记住的上下文。不要写成一句话流水账，要像给隔了几天没看的读者做前情提要。",
    "detailed": "summary 用 700-1000 字做详细前情提要，按自然段覆盖事件推进、人物动机、场景变化、关键信息增量、暗线提示和读者下一章阅读时应留意的上下文。",
}


def analyze_text(text: str, chapter_title: str, detail_level: str = "standard", spoiler_free: bool = True):
    if not API_KEY:
        raise RuntimeError("缺少 DEEPSEEK_API_KEY")

    summary_rule = SUMMARY_RULES.get(detail_level, SUMMARY_RULES["standard"])
    spoiler_rule = (
        "必须开启无剧透模式：只基于当前章节文本分析，不得引用后文剧情、百科资料、读者评论或模型记忆。"
        if spoiler_free
        else "可以结合常识做阅读提示，但仍然不要透露章节正文之外的明确后文剧情。"
    )

    prompt = f"""
你是一个长篇小说阅读助手。{spoiler_rule}

章节标题：{chapter_title}

输出要求：
1. 只能返回 JSON，不要 Markdown，不要解释。
2. {summary_rule}
3. characters 列出本章关键人物，字段为 name、note。
4. foreshadowing 列出疑似伏笔或需要留意的线索，字段为 clue、reason、confidence，confidence 为 0-100。
5. terms 列出读者可能需要记住的地名、物品、势力、术语，字段为 term、meaning。
6. graph.nodes 用 id、label、level，level 只能是 core 或 normal。
7. graph.edges 用 from、to、label。

JSON 结构：
{{
  "summary": "",
  "characters": [{{"name": "", "note": ""}}],
  "foreshadowing": [{{"clue": "", "reason": "", "confidence": 70}}],
  "terms": [{{"term": "", "meaning": ""}}],
  "graph": {{
    "nodes": [{{"id": "n1", "label": "", "level": "core"}}],
    "edges": [{{"from": "n1", "to": "n2", "label": ""}}]
  }}
}}

章节正文：
{text}
"""

    response = requests.post(
        API_URL,
        headers={
            "Authorization": f"Bearer {API_KEY}",
            "Content-Type": "application/json",
        },
        json={
            "model": MODEL,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.2,
        },
        timeout=45,
    )
    response.raise_for_status()

    payload = response.json()
    try:
        raw = payload["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise RuntimeError(f"AI 响应格式异常：{payload}") from exc

    parsed = _extract_json(raw)
    return _normalize_result(parsed, raw)


def answer_from_memory(question: str, memories: list[dict], spoiler_free: bool = True):
    if not API_KEY:
        raise RuntimeError("缺少 DEEPSEEK_API_KEY")

    spoiler_rule = (
        "必须开启无剧透模式：只能基于下面提供的已读章节记忆回答，不能引用后文、百科、评论或模型记忆。"
        if spoiler_free
        else "优先基于下面提供的章节记忆回答；如果做推测，必须明确标注为推测。"
    )

    compact_memories = []
    for item in memories[-30:]:
        compact_memories.append(
            {
                "chapter_title": item.get("chapter_title", ""),
                "summary": item.get("summary", ""),
                "characters": item.get("characters", [])[:8],
                "foreshadowing": item.get("foreshadowing", [])[:8],
                "terms": item.get("terms", [])[:8],
            }
        )

    prompt = f"""
你是一个长篇小说无剧透阅读问答助手。{spoiler_rule}

回答要求：
1. 只回答用户问题，不要输出 JSON。
2. 如果已有记忆不足以回答，直接说"目前已读记忆里没有足够信息"。
3. 回答要引用相关章节标题，方便用户回想。
4. 不要贴原文，不要编造没出现过的情节。
5. 如果问题涉及人物关系、伏笔或术语，优先给出条理清晰的要点。

用户问题：
{question}

已读章节记忆：
{json.dumps(compact_memories, ensure_ascii=False)}
"""

    response = requests.post(
        API_URL,
        headers={
            "Authorization": f"Bearer {API_KEY}",
            "Content-Type": "application/json",
        },
        json={
            "model": MODEL,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.2,
        },
        timeout=45,
    )
    response.raise_for_status()

    payload = response.json()
    try:
        return payload["choices"][0]["message"]["content"].strip()
    except (KeyError, IndexError, TypeError) as exc:
        raise RuntimeError(f"AI 响应格式异常：{payload}") from exc


def review_recent_chapters(book_title: str, memories: list[dict]):
    """基于最近 N 章的结构化记忆生成无剧透追更回顾。"""
    if not API_KEY:
        raise RuntimeError("缺少 DEEPSEEK_API_KEY")

    # 构建紧凑的章节摘要
    chapters_text = []
    for item in memories:
        chapter_info = f"【{item.get('chapter_title', '未知章节')}】\n{item.get('summary', '暂无摘要')}"
        # 提取关键人物
        characters = item.get("characters", [])[:5]
        if characters:
            names = [c.get("name", c.get("note", "")) for c in characters]
            chapter_info += f"\n关键人物：{', '.join(names)}"
        # 提取重要伏笔
        foreshadowing = item.get("foreshadowing", [])[:3]
        if foreshadowing:
            clues = [f.get("clue", "") for f in foreshadowing]
            chapter_info += f"\n伏笔线索：{', '.join(clues)}"
        chapters_text.append(chapter_info)

    prompt = f"""
你是一个长篇小说追更回顾助手。请基于最近几章的结构化记忆，生成无剧透追更回顾。

书名：{book_title}
覆盖章节数：{len(memories)} 章

规则：
1. 只基于给定章节记忆。
2. 不得引用后文剧情。
3. 不要逐章流水账，要总结主线推进。
4. 重点帮助隔了几天没看的读者恢复阅读状态。

最近章节记忆：
{chr(10).join(chapters_text)}

请用自然语言输出以下内容（不要 JSON）：

1. **主线推进**：最近几章主要发生了什么，主线推进到什么位置
2. **关键人物动向**：重要人物的状态变化和行为动机
3. **重要伏笔和异常细节**：读者应该留意的线索
4. **当前阅读上下文**：现在接着看最需要记住的信息
5. **接下来阅读提示**：无剧透的阅读指引，帮读者留意可能重要的内容
"""

    response = requests.post(
        API_URL,
        headers={
            "Authorization": f"Bearer {API_KEY}",
            "Content-Type": "application/json",
        },
        json={
            "model": MODEL,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.3,
        },
        timeout=60,
    )
    response.raise_for_status()

    payload = response.json()
    try:
        return payload["choices"][0]["message"]["content"].strip()
    except (KeyError, IndexError, TypeError) as exc:
        raise RuntimeError(f"AI 响应格式异常：{payload}") from exc


def check_foreshadowing_payoff(current_analysis: dict, saved_clues: list[dict]):
    """伏笔回收检测：判断当前章节是否回应、推进或回收了历史伏笔。"""
    if not API_KEY:
        raise RuntimeError("缺少 DEEPSEEK_API_KEY")

    prompt = f"""
你是一个长篇小说伏笔追踪助手。请判断当前章节是否回应、推进或回收了用户之前保存的伏笔。

规则：
1. 只能基于当前章节分析结果和历史伏笔记录。
2. 不得引用后文、百科或模型记忆。
3. 不确定就标注为"possible"，不要强行认定。
4. 只返回 JSON，不要 Markdown，不要解释。

当前章节分析：
- 章节标题：{current_analysis.get("chapter_title", "")}
- 概要：{current_analysis.get("summary", "")}
- 人物：{json.dumps(current_analysis.get("characters", [])[:10], ensure_ascii=False)}
- 本章新线索：{json.dumps(current_analysis.get("foreshadowing", [])[:5], ensure_ascii=False)}

历史伏笔列表：
{json.dumps(saved_clues[-30:], ensure_ascii=False)}

请返回 JSON：
{{
  "matches": [
    {{
      "saved_clue_id": "历史伏笔 ID",
      "current_evidence": "当前章节中与它相关的新信息",
      "match_type": "echo|progress|payoff|possible",
      "confidence": 0-100,
      "reader_message": "给读者的无剧透提示"
    }}
  ]
}}

注意：
- match_type: echo=重复出现此线索, progress=线索有明显推进, payoff=伏笔回收/揭晓, possible=可能与历史伏笔相关但不确定
- 如果当前章节与任何历史伏笔都无关，返回空数组
- reader_message 要简短，不透露后文
"""

    response = requests.post(
        API_URL,
        headers={
            "Authorization": f"Bearer {API_KEY}",
            "Content-Type": "application/json",
        },
        json={
            "model": MODEL,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.2,
        },
        timeout=60,
    )
    response.raise_for_status()

    payload = response.json()
    try:
        raw = payload["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise RuntimeError(f"AI 响应格式异常：{payload}") from exc

    parsed = _extract_json(raw)
    matches = parsed.get("matches", [])
    if not isinstance(matches, list):
        matches = []
    return matches


def suggest_questions(book_title: str, recent_analyses: list[dict]):
    """基于最近章节分析结果，用 AI 生成推荐问题。"""
    if not API_KEY:
        raise RuntimeError("缺少 DEEPSEEK_API_KEY")

    # 构建紧凑的章节上下文
    chapters_context = []
    all_characters = set()
    all_clues = []
    all_terms = set()

    for analysis in recent_analyses:
        ch_title = analysis.get("chapter_title", "未知")
        summary = analysis.get("summary", "")[:200]
        characters = [c.get("name", "") for c in analysis.get("characters", [])[:5] if c.get("name")]
        clues = [c.get("clue", "") for c in analysis.get("foreshadowing", [])[:3] if c.get("clue")]
        terms = [t.get("term", "") for t in analysis.get("terms", [])[:3] if t.get("term")]

        chapters_context.append(
            f"【{ch_title}】{summary}" +
            (f" 人物：{', '.join(characters)}" if characters else "") +
            (f" 伏笔：{', '.join(clues)}" if clues else "")
        )
        all_characters.update(characters)
        all_clues.extend(clues)
        all_terms.update(terms)

    prompt = f"""你是一个长篇小说阅读助手。读者正在追《{book_title}》，请基于最近章节内容，生成 3-5 个读者"应该问但可能没想到"的问题。

规则：
1. 问题要有价值——帮助读者理解剧情、人物动机、伏笔走向
2. 必须是基于已读记忆能回答的（不要问需要后文才能解答的问题）
3. 问题要自然，像读者之间的讨论
4. 按重要性排序
5. 只返回 JSON 数组，不要 Markdown

最近章节：
{chr(10).join(chapters_context[-3:])}

已知关键人物：{', '.join(list(all_characters)[:12]) or '暂无'}
已知伏笔线索：{', '.join(all_clues[:6]) or '暂无'}
已知术语：{', '.join(list(all_terms)[:8]) or '暂无'}

请返回 JSON 数组：
[
  {{"question": "问题文本", "reason": "为什么这个问题值得问（10字以内）"}}
]"""

    response = requests.post(
        API_URL,
        headers={
            "Authorization": f"Bearer {API_KEY}",
            "Content-Type": "application/json",
        },
        json={
            "model": MODEL,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.5,
            "max_tokens": 400,
        },
        timeout=30,
    )
    response.raise_for_status()

    payload = response.json()
    try:
        raw = payload["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise RuntimeError(f"AI 响应格式异常：{payload}") from exc

    # 提取 JSON 数组
    match = re.search(r"```json\s*([\s\S]*?)```", raw)
    if match:
        raw = match.group(1)
    start = raw.find("[")
    end = raw.rfind("]")
    if start != -1 and end != -1 and end > start:
        questions = json.loads(raw[start:end + 1])
        if isinstance(questions, list):
            return questions[:5]

    return []
