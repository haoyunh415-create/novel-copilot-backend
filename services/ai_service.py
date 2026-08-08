import json
import os
import re

import requests
from dotenv import load_dotenv

load_dotenv()

# 使用 Session 并禁用系统代理（Windows 上 requests 会从注册表读取代理配置）
_session = requests.Session()
_session.trust_env = False

API_KEY = os.getenv("DEEPSEEK_API_KEY")
API_URL = os.getenv("DEEPSEEK_API_URL", "https://api.deepseek.com/v1/chat/completions")
MODEL = os.getenv("DEEPSEEK_MODEL", "deepseek-v4-flash")


def _strip_ai_chatter(text: str) -> str:
    """移除 AI 在 JSON 前后的废话（"好的，这是分析结果：" 等）"""
    # 常见的中文/英文 AI 前缀
    prefixes = [
        r"好的[，,]?\s*(?:这是[您你]的?)?[（(]?分析[）)]?结果[：:]\s*",
        r"以下是[您你]?的?[（(]?(?:章节)?[）)]?分析[：:]\s*",
        r"以下是[您你]需要[的]?[（(]?JSON[）)]?[：:]\s*",
        r"好的[，,]?\s*为您分析[：:]\s*",
        r"根据[您你]的?\s*要求[，,]\s*分析如下[：:]\s*",
        r"Here\s+is\s+the\s+(?:analysis|JSON)[：:]\s*",
        r"Sure[,!]\s+here['']s\s+the\s+(?:analysis|JSON)[：:]\s*",
        r"当然[，,]?\s*这是[：:]\s*",
        r"明白了?[，,]?\s*(?:这是|以下)?[：:]?\s*",
    ]
    for pat in prefixes:
        text = re.sub(r"^" + pat, "", text, flags=re.IGNORECASE)

    # 常见 AI 后缀
    suffixes = [
        r"\s*希望[这以上].*?[。！\.!]?\s*$",
        r"\s*如果有.*?(?:可以|需要).*?[。！\.!]?\s*$",
        r"\s*以上是.*?(?:分析|结果|内容).*?[。！\.!]?\s*$",
        r"\s*I hope this.*?[\.!]?\s*$",
    ]
    for pat in suffixes:
        text = re.sub(pat, "", text, flags=re.IGNORECASE)

    return text.strip()


def _extract_json(text: str):
    """多策略 JSON 提取，应对 AI 返回格式不一致的情况"""
    # 预处理：移除 AI 废话
    text = _strip_ai_chatter(text)

    # 策略 1: ```json ... ``` 代码块
    match = re.search(r"```json\s*([\s\S]*?)```", text)
    if match:
        text = match.group(1)
    else:
        # 策略 1b: ``` ... ``` 任意代码块
        match = re.search(r"```\s*([\s\S]*?)```", text)
        if match:
            text = match.group(1)

    # 策略 2: 找最外层花括号（从第一个 { 到最后一个 }）
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise ValueError("AI 没有返回 JSON")

    json_str = text[start: end + 1]

    # 尝试直接解析
    try:
        return json.loads(json_str)
    except json.JSONDecodeError:
        pass

    # 策略 3: 修复常见 JSON 问题后重试
    fixed = _fix_json(json_str)
    try:
        return json.loads(fixed)
    except json.JSONDecodeError:
        pass

    # 策略 4: 激进清理后重试（处理内嵌控制字符、未转义换行等）
    aggressive = _fix_json_aggressive(json_str)
    return json.loads(aggressive)


def _fix_json(text: str) -> str:
    """修复 AI 返回 JSON 的常见格式问题"""
    # 移除尾随逗号（对象和数组）
    text = re.sub(r",(\s*[}\]])", r"\1", text)
    # 修复未闭合的字符串（在行尾添加引号）
    lines = text.split("\n")
    fixed_lines = []
    for line in lines:
        stripped = line.rstrip()
        if stripped.endswith(": ") or stripped.endswith(":\t"):
            stripped += '""'
        fixed_lines.append(stripped)
    text = "\n".join(fixed_lines)
    # 移除注释行
    text = re.sub(r"^\s*//.*$", "", text, flags=re.MULTILINE)
    return text


def _fix_json_aggressive(text: str) -> str:
    """激进修复：处理更复杂的 JSON 格式问题"""
    # 去除 BOM 和不可见控制字符（保留换行和制表符）
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", text)
    return text


def _call_ai(messages: list[dict], temperature: float = 0.2, timeout: int = 35, max_retries: int = 2, max_tokens: int = None):
    """调用 AI API，带自动重试"""
    last_error = None
    for attempt in range(max_retries):
        try:
            body = {
                "model": MODEL,
                "messages": messages,
                "temperature": temperature,
            }
            if max_tokens:
                body["max_tokens"] = max_tokens
            response = _session.post(
                API_URL,
                headers={
                    "Authorization": f"Bearer {API_KEY}",
                    "Content-Type": "application/json",
                },
                json=body,
                timeout=timeout,
            )
            response.raise_for_status()
            return response.json()
        except requests.Timeout:
            last_error = RuntimeError("AI 服务响应超时，请缩短章节内容或稍后重试")
            if attempt < max_retries - 1:
                timeout += 15  # 重试时延长超时
        except requests.HTTPError as e:
            status = e.response.status_code if e.response else None
            if status in (429, 500, 502, 503) and attempt < max_retries - 1:
                import time
                time.sleep(1.5 * (attempt + 1))  # 指数退避
                last_error = e
                continue
            raise
        except requests.ConnectionError:
            last_error = RuntimeError("无法连接 AI 服务")
            if attempt < max_retries - 1:
                import time
                time.sleep(1)
                continue

    raise last_error or RuntimeError("AI 调用失败")


def _normalize_result(result: dict, raw: str, degraded: bool = False):
    graph = result.get("graph") if (isinstance(result, dict) and isinstance(result.get("graph"), dict)) else {}
    summary = str(result.get("summary") or "").strip()
    if not summary:
        # 兜底：从 raw 中提取纯文本（去除 JSON 格式符、代码块、AI 废话）
        summary = _raw_to_plain_text(raw)
    return {
        "summary": summary,
        "characters": result.get("characters") if isinstance(result.get("characters"), list) else [],
        "foreshadowing": result.get("foreshadowing") if isinstance(result.get("foreshadowing"), list) else [],
        "terms": result.get("terms") if isinstance(result.get("terms"), list) else [],
        "graph": {
            "nodes": graph.get("nodes") if isinstance(graph.get("nodes"), list) else [],
            "edges": graph.get("edges") if isinstance(graph.get("edges"), list) else [],
        },
        "raw": raw,
        "degraded": degraded,
    }


def _raw_to_plain_text(raw: str, max_len: int = 500) -> str:
    """将 AI 原始输出转为纯文本摘要（去除 JSON 结构、代码块、格式符）"""
    text = raw.strip()
    # 移除代码块标记
    text = re.sub(r"```[\s\S]*?```", "", text)
    text = re.sub(r"```\w*", "", text)
    # 移除 JSON 结构符号和逗号
    text = re.sub(r'[\[\]{}"\\,]', " ", text)
    # 移除 AI 废话前缀
    text = _strip_ai_chatter(text)
    # 移除键名残余（如 "summary":, "characters": 等），仅移除 key: 部分，保留值
    text = re.sub(r'\b(summary|characters|foreshadowing|terms|graph|nodes|edges|id|label|level|name|note|clue|reason|confidence|term|meaning|from|to)\s*[:：]\s*', " ", text, flags=re.IGNORECASE)
    # 合并多余空白和标点碎片
    text = re.sub(r"\s+", " ", text).strip()
    text = text.strip(",;，； ")
    if not text or len(text) < 5:
        return "AI 返回内容异常，请稍后重试"
    return text[:max_len]


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

    # 截断过长文本（DeepSeek 上下文窗口充足，但过长会变慢）
    text = text[:8000] if len(text) > 8000 else text

    prompt = f"""你是一个专业的长篇小说阅读助手。{spoiler_rule}

章节标题：{chapter_title}

输出要求（严格 JSON，不能有任何其他内容）：
1. {summary_rule}
2. characters：至少 1 个，最多 5 个关键人物。每人包含 name（名称）和 note（动向，15字以内）。即使出场人物少也要标注最重要的 1 个。正文乱码则返回空数组 []
3. foreshadowing：0-3 条线索。每条含 clue（描述）、reason（为什么是伏笔，20字以内）、confidence（0-100）。有值得关注的细节就标，尽量不空
4. terms：列出 0-3 个关键术语。每条含 term（术语）和 meaning（含义）
5. graph.nodes：与 characters 一致，每人 id、label、level（core/normal）
6. graph.edges：人物关系边，from、to、label（如"师徒""敌对"）

JSON 结构：
{{"summary":"...","characters":[{{"name":"","note":""}}],"foreshadowing":[{{"clue":"","reason":"","confidence":70}}],"terms":[{{"term":"","meaning":""}}],"graph":{{"nodes":[{{"id":"n1","label":"","level":"core"}}],"edges":[{{"from":"n1","to":"n2","label":""}}]}}}}

正文：
{text}"""

    payload = _call_ai([
        {"role": "system", "content": "你是一个专业的小说分析助手，只返回符合要求的 JSON，不输出任何其他内容。"},
        {"role": "user", "content": prompt},
    ], temperature=0.2, timeout=35, max_tokens=4096)

    try:
        raw = payload["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise RuntimeError("AI 响应格式异常") from exc

    # 尝试 JSON 解析，失败则降级为纯文本摘要
    try:
        parsed = _extract_json(raw)
    except (ValueError, json.JSONDecodeError):
        # 终极兜底：把 AI 返回的原始文本当作摘要
        clean_text = re.sub(r"```[\s\S]*?```", "", raw).strip()
        if len(clean_text) < 20:
            raise RuntimeError("AI 返回内容异常，请稍后重试")
        return _normalize_result({"summary": clean_text[:800]}, raw, degraded=True)

    return _normalize_result(parsed, raw)


def analyze_summary_only(text: str, chapter_title: str, spoiler_free: bool = True, detail_level: str = "standard"):
    """只生成章节摘要，~3-5 秒快速返回"""
    if not API_KEY:
        raise RuntimeError("缺少 DEEPSEEK_API_KEY")

    summary_rule = SUMMARY_RULES.get(detail_level, SUMMARY_RULES["standard"])
    spoiler_rule = (
        "必须开启无剧透模式：只基于当前章节文本分析，不得引用后文剧情。"
        if spoiler_free else ""
    )
    text = text[:8000] if len(text) > 8000 else text

    prompt = f"""章节标题：{chapter_title}。{spoiler_rule}
{summary_rule}
不要输出 JSON，直接返回纯文本摘要，不要任何格式标记和前缀。
正文：{text}"""

    payload = _call_ai([
        {"role": "system", "content": "你是一个专业的小说分析助手。只返回摘要纯文本，不输出 JSON，不加前缀或解释。"},
        {"role": "user", "content": prompt},
    ], temperature=0.2, timeout=30, max_retries=2, max_tokens=2048)

    raw = payload["choices"][0]["message"]["content"]
    if not raw or not str(raw).strip():
        raise RuntimeError("AI 返回空内容，可能触发内容安全过滤，请稍后重试")
    # 直接返回纯文本，不再走 JSON 解析
    summary = _strip_ai_chatter(raw).strip()
    return {"summary": summary}


def analyze_details_only(text: str, chapter_title: str, spoiler_free: bool = True):
    """生成人物、伏笔、术语、关系图（不含摘要），~8-12 秒"""
    if not API_KEY:
        raise RuntimeError("缺少 DEEPSEEK_API_KEY")

    spoiler_rule = (
        "必须开启无剧透模式：只基于当前章节文本分析，不得引用后文剧情。"
        if spoiler_free else ""
    )
    text = text[:8000] if len(text) > 8000 else text

    prompt = f"""章节标题：{chapter_title}。{spoiler_rule}
分析以下内容，严格按 JSON 返回（只输出 JSON，不要任何其他文字）：
- characters：至少列出 1 个关键人物，最多 5 个。即使章节出场人物少，也要至少标注本章最重要的 1 个人物（name + note 15字以内，说明其本章动向和重要性）
- foreshadowing：0-3 条伏笔线索。如果章节有值得关注的细节、反常事件、暗示未来发展的内容，请标注（clue + reason 15字以内 + confidence 0-100）。尽量不要返回空数组
- terms：0-3 个关键术语（term + meaning）
- graph：人物关系 nodes（id=n1,n2...、label、level=core/normal）+ edges（from、to、label），至少要有 1 个 node
JSON 格式：{{{{"characters":[{{{{"name":"","note":""}}}}],"foreshadowing":[{{{{"clue":"","reason":"","confidence":70}}}}],"terms":[{{{{"term":"","meaning":""}}}}],"graph":{{{{"nodes":[{{{{"id":"n1","label":"","level":"core"}}}}],"edges":[{{{{"from":"n1","to":"n2","label":""}}}}]}}}}}}}}
正文：{text}"""

    payload = _call_ai([
        {"role": "system", "content": "你是一个专业的小说分析助手，只返回 JSON，不输出任何其他内容。"},
        {"role": "user", "content": prompt},
    ], temperature=0.2, timeout=30, max_retries=2, max_tokens=2048)

    try:
        raw = payload["choices"][0]["message"]["content"]
        parsed = _extract_json(raw)
        result = _normalize_result({**parsed, "summary": " "}, raw)
        result["summary"] = ""  # 摘要由 progressive 端点从 summary 调用填充
        return result
    except Exception:
        return {"summary": "", "characters": [], "foreshadowing": [], "terms": [], "graph": {"nodes": [], "edges": []}}


def analyze_text_stream(text: str, chapter_title: str, detail_level: str = "standard", spoiler_free: bool = True):
    """流式分析章节，yield (event_type: str, data: dict) 元组。

    event_type 取值：
    - "progress": 阶段变化，data={"stage": "connecting|reading|parsing", "elapsed_s": float}
    - "done": 完成，data={"result": {...}}（同 analyze_text 返回格式）
    - "error": 失败，data={"message": str}
    """
    import time as _time_module
    start_time = _time_module.time()

    if not API_KEY:
        yield ("error", {"message": "服务器 AI 服务未配置，请联系管理员"})
        return

    summary_rule = SUMMARY_RULES.get(detail_level, SUMMARY_RULES["standard"])
    spoiler_rule = (
        "必须开启无剧透模式：只基于当前章节文本分析，不得引用后文剧情、百科资料、读者评论或模型记忆。"
        if spoiler_free
        else "可以结合常识做阅读提示，但仍然不要透露章节正文之外的明确后文剧情。"
    )

    text = text[:8000] if len(text) > 8000 else text

    prompt = f"""你是一个专业的长篇小说阅读助手。{spoiler_rule}

章节标题：{chapter_title}

输出要求（严格 JSON）：
1. {summary_rule}
2. characters：至少 1 个，最多 5 个关键人物（name + note 15字以内）。即使出场人物少也要标注最重要的 1 个
3. foreshadowing：0-3 条线索（clue + reason 20字以内 + confidence 0-100）。有值得关注的细节就标，尽量不空
4. terms：0-3 个关键术语（term + meaning）
5. graph.nodes：与 characters 一致，每人 id、label、level（core/normal）
6. graph.edges：人物关系边 from、to、label

JSON 结构：
{{{{"summary":"...","characters":[{{{{"name":"","note":""}}}}],"foreshadowing":[{{{{"clue":"","reason":"","confidence":70}}}}],"terms":[{{{{"term":"","meaning":""}}}}],"graph":{{{{"nodes":[{{{{"id":"n1","label":"","level":"core"}}}}],"edges":[{{{{"from":"n1","to":"n2","label":""}}}}]}}}}}}}}

正文：
{text}"""

    yield ("progress", {"stage": "connecting", "elapsed_s": round(_time_module.time() - start_time, 1)})

    try:
        response = _session.post(
            API_URL,
            headers={
                "Authorization": f"Bearer {API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "model": MODEL,
                "messages": [
                    {"role": "system", "content": "你是一个专业的小说分析助手，只返回符合要求的 JSON，不输出任何其他内容。"},
                    {"role": "user", "content": prompt},
                ],
                "temperature": 0.2,
                "stream": True,
                "max_tokens": 4096,
            },
            timeout=(10, 60),
            stream=True,
        )
        response.raise_for_status()
    except requests.Timeout:
        yield ("error", {"message": "AI 服务响应超时，章节内容太长或网络不稳定，请稍后重试"})
        return
    except requests.ConnectionError:
        yield ("error", {"message": "无法连接 AI 服务，请检查网络后重试"})
        return
    except requests.HTTPError as e:
        status = e.response.status_code if e.response else None
        if status == 429:
            yield ("error", {"message": "AI 服务繁忙，请稍等几秒后重试"})
        elif status in (401, 403):
            yield ("error", {"message": "AI 服务认证失败，请联系管理员检查 API Key"})
        else:
            yield ("error", {"message": f"AI 服务暂时不可用（{status}），请稍后重试"})
        return

    yield ("progress", {"stage": "reading", "elapsed_s": round(_time_module.time() - start_time, 1)})

    accumulated = ""
    try:
        for line in response.iter_lines(decode_unicode=True):
            if not line or not line.startswith("data: "):
                continue
            data_str = line[6:]
            if data_str == "[DONE]":
                break
            try:
                chunk = json.loads(data_str)
                content = chunk["choices"][0].get("delta", {}).get("content", "")
                if content:
                    accumulated += content
            except (json.JSONDecodeError, KeyError, IndexError):
                continue
    except requests.Timeout:
        yield ("error", {"message": "AI 服务响应超时，请稍后重试"})
        return
    except Exception as e:
        yield ("error", {"message": f"AI 流式读取异常，请稍后重试"})
        return

    yield ("progress", {"stage": "parsing", "elapsed_s": round(_time_module.time() - start_time, 1)})

    if not accumulated or len(accumulated) < 10:
        yield ("error", {"message": "AI 返回内容异常，请稍后重试"})
        return

    # JSON 解析，失败降级为纯文本摘要
    try:
        parsed = _extract_json(accumulated)
    except (ValueError, json.JSONDecodeError):
        clean_text = re.sub(r"```[\s\S]*?```", "", accumulated).strip()
        if len(clean_text) < 20:
            yield ("error", {"message": "AI 返回内容异常，请稍后重试"})
            return
        result = _normalize_result({"summary": clean_text[:800]}, accumulated, degraded=True)
        yield ("done", {"result": result})
        return

    result = _normalize_result(parsed, accumulated)
    yield ("done", {"result": result})


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

    payload = _call_ai([
        {"role": "user", "content": prompt},
    ], temperature=0.2, timeout=60)

    try:
        return payload["choices"][0]["message"]["content"].strip()
    except (KeyError, IndexError, TypeError) as exc:
        raise RuntimeError("AI 响应格式异常") from exc


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

    payload = _call_ai([
        {"role": "user", "content": prompt},
    ], temperature=0.3, timeout=60)

    try:
        return payload["choices"][0]["message"]["content"].strip()
    except (KeyError, IndexError, TypeError) as exc:
        raise RuntimeError("AI 响应格式异常") from exc


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

    payload = _call_ai([
        {"role": "user", "content": prompt},
    ], temperature=0.2, timeout=60)

    try:
        raw = payload["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise RuntimeError("AI 响应格式异常") from exc

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

    payload = _call_ai([
        {"role": "user", "content": prompt},
    ], temperature=0.5, timeout=30)

    try:
        raw = payload["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise RuntimeError("AI 响应格式异常") from exc

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


# ── 全书复盘报告 ──

FULL_REPORT_COST = 20  # 消耗积分
CHUNK_SIZE = 60        # 每批处理的章节数
LIGHT_CHAPTERS = 10    # 少于此章数用轻量报告，更快


def generate_full_report(book_title: str, memories: list[dict]):
    """生成全书复盘报告。

    memories: 按章节顺序排列的记忆列表，每项包含 chapter_title, summary, characters, foreshadowing, terms

    策略：
    - <=60章：单次生成完整报告
    - >60章：分批生成阶段总结，再汇总成完整报告
    """
    if not API_KEY:
        raise RuntimeError("缺少 DEEPSEEK_API_KEY")

    if not memories:
        raise RuntimeError("没有可用的章节记忆")

    if len(memories) <= CHUNK_SIZE:
        chapters_text = _build_chapters_text(memories)
        return _do_single_pass_report(book_title, chapters_text, len(memories))

    # 多阶段：分批 → 阶段总结 → 最终报告
    chunks = [memories[i:i + CHUNK_SIZE] for i in range(0, len(memories), CHUNK_SIZE)]
    phase_summaries = []

    for i, chunk in enumerate(chunks):
        chunk_start = i * CHUNK_SIZE + 1
        chunk_end = min((i + 1) * CHUNK_SIZE, len(memories))
        chunk_text = _build_chapters_text(chunk)
        phase_summaries.append(
            _generate_chunk_summary(book_title, chunk_text, chunk_start, chunk_end, len(chunk))
        )

    combined = "\n\n---\n\n".join(
        f"## 阶段 {i + 1}（第{i * CHUNK_SIZE + 1}-{min((i + 1) * CHUNK_SIZE, len(memories))}章）\n{s}"
        for i, s in enumerate(phase_summaries)
    )

    return _do_final_report(book_title, combined, len(memories))


def _build_chapters_text(memories: list[dict]) -> str:
    """将章节记忆列表压缩为文本。"""
    parts = []
    for m in memories:
        lines = [f"【{m.get('chapter_title', '?')}】{m.get('summary', '')[:300]}"]
        chars = [c.get("name", "") for c in m.get("characters", [])[:5] if c.get("name")]
        if chars:
            lines.append(f"  人物：{', '.join(chars)}")
        clues = [c.get("clue", "") for c in m.get("foreshadowing", [])[:3] if c.get("clue")]
        if clues:
            lines.append(f"  线索：{'；'.join(clues)}")
        terms = [t.get("term", "") for t in m.get("terms", [])[:3] if t.get("term")]
        if terms:
            lines.append(f"  术语：{'、'.join(terms)}")
        parts.append("\n".join(lines))
    return "\n".join(parts)


def _generate_chunk_summary(book_title: str, chunk_text: str,
                             chunk_start: int, chunk_end: int, count: int) -> str:
    """为一批章节生成阶段性总结。"""
    prompt = f"""你是《{book_title}》的阅读助手。请基于以下章节的结构化记忆，生成这部分内容的阶段性总结。

章节范围：第{chunk_start}-{chunk_end}章（共 {count} 章）

规则：
1. 只基于给定记忆，不编造
2. 按主线推进、人物变化、伏笔线索、关键事件四个维度总结
3. 每条总结尽量具体，标注相关章节标题
4. 控制在 800 字以内

章节记忆：
{chunk_text}

请输出阶段性总结："""

    payload = _call_ai([
        {"role": "user", "content": prompt},
    ], temperature=0.3, timeout=60)
    try:
        return payload["choices"][0]["message"]["content"].strip()
    except (KeyError, IndexError, TypeError) as exc:
        raise RuntimeError("阶段总结生成失败") from exc


def _do_single_pass_report(book_title: str, chapters_text: str, total: int) -> str:
    """单阶段：直接从章节记忆生成完整复盘报告。"""
    if total <= LIGHT_CHAPTERS:
        return _call_light_report_api(book_title, chapters_text, total,
                                      input_label="章节记忆", extra_rule="")
    return _call_report_api(book_title, chapters_text, total,
                            input_label="章节记忆", extra_rule="")


def _do_final_report(book_title: str, combined_summaries: str, total: int) -> str:
    """最终阶段：从阶段总结汇总生成完整复盘报告。"""
    return _call_report_api(book_title, combined_summaries, total,
                            input_label="阶段性总结",
                            extra_rule="4. 各阶段的细节要有机整合，不要简单罗列阶段编号\n")


def _call_report_api(book_title: str, content: str, total: int,
                      input_label: str, extra_rule: str) -> str:
    """统一的报告生成 API 调用。"""
    prompt = f"""你是《{book_title}》的深度阅读复盘助手。请基于以下 {input_label}，生成一份完整的全书阅读复盘报告。

覆盖章节数：{total} 章

规则：
1. 只基于给定内容，不编造，不引用后文
2. 按以下结构组织报告，用 Markdown 格式
3. 语言生动但有深度，像一个资深书评人
{extra_rule}
5. 每个重要事件尽量注明相关章节

{input_label}：
{content}

请按以下结构输出报告：

## 📖 主线梳理
概述全书主线剧情走向，分阶段描述情节推进，标注关键转折点。

## 🕐 关键剧情节点
按时间线列出 5-10 个最重要的剧情节点，每个节点说明事件及其对后续剧情的影响。

## 👥 人物谱系
列出重要人物，每人包括：身份定位、性格特点、关键经历、与其他角色的关系。

## 🔍 伏笔追踪
列出重要的伏笔线索，注明埋设章节，以及是否已回收或仍在铺垫中。

## 📚 世界观设定
整理重要的世界观元素：势力分布、修炼/社会体系、特殊规则、关键地名和物品。

## 💡 阅读建议
基于已读内容，给读者的后续阅读建议，不剧透。"""

    payload = _call_ai([
        {"role": "system", "content": "你是一个专业的书评人和阅读复盘助手。"},
        {"role": "user", "content": prompt},
    ], temperature=0.4, timeout=120)
    try:
        return payload["choices"][0]["message"]["content"].strip()
    except (KeyError, IndexError, TypeError) as exc:
        raise RuntimeError(f"报告生成失败：{payload}") from exc


def _call_light_report_api(book_title: str, content: str, total: int,
                           input_label: str, extra_rule: str) -> str:
    """轻量报告（≤10章）：精简结构，更快生成。"""
    prompt = f"""你是《{book_title}》的阅读助手。请基于以下 {input_label}，生成一份简洁的阅读复盘。

覆盖章节数：{total} 章

规则：
1. 只基于给定内容，不编造
2. 用简洁的 Markdown 格式，每条点到为止
{extra_rule}

{input_label}：
{content}

请按以下结构输出（每部分控制在 3-5 条要点）：

## 📖 主线梳理
## 🕐 关键节点
## 👥 人物一览
## 🔍 伏笔线索"""

    payload = _call_ai([
        {"role": "system", "content": "你是一个专业的阅读复盘助手。回答简洁有力，每条不超过两句话。"},
        {"role": "user", "content": prompt},
    ], temperature=0.3, timeout=60)
    try:
        return payload["choices"][0]["message"]["content"].strip()
    except (KeyError, IndexError, TypeError) as exc:
        raise RuntimeError(f"报告生成失败：{payload}") from exc
