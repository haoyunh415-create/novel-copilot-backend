"""起点中文网「错位字体」加密解密模块。

起点（阅文）把正文常用字替换成生僻字（CJK 扩展 A / 兼容表意文字），并配一个
动态生成的 @font-face「错位字体」（每次请求都变）。该字体的 glyph 轮廓就是真实
汉字的轮廓，只是码点被重排或替换——因此直接 innerText 读到的字符是错的（乱码），
靠字体渲染后才是人眼看到的正确汉字。

本模块通过「解析字体 cmap + 字形匹配」还原出「码点 → 真实汉字」的映射，从而把
乱码正文还原成明文：

    1. 下载页面上的字体文件（.woff2 / .ttf）
    2. fontTools 解析 cmap 表，得到字体覆盖的码点
    3. 对正文里实际出现的每个码点，渲染其 glyph 位图
    4. 与标准黑体渲染的常用字库逐字做余弦相似度比对，取最像者
    5. 汇总映射并替换正文

仅用于学习研究 / 辅助已购内容阅读，请遵守目标平台服务条款。
"""

import hashlib
import io
import logging
import os
import threading
from typing import Dict, List, Optional, Tuple

import numpy as np
import requests
from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont

# ── 标准参照字体（用于字形比对的基准字体）─────────────────────────────
# 依次尝试；服务器部署时可用 fonts-noto-cjk 或文泉驿，或设 QIDIAN_STD_FONT 指定。
_STD_FONT_CANDIDATES = [
    os.environ.get("QIDIAN_STD_FONT", ""),   # 环境变量优先（服务器部署可指定路径）
    "C:/Windows/Fonts/simhei.ttf",           # Windows 黑体
    "C:/Windows/Fonts/msyh.ttc",             # Windows 微软雅黑
    "C:/Windows/Fonts/simsun.ttc",           # Windows 宋体
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
]

_CANVAS = 64          # 字形渲染画布边长
_GLYPH = 48           # 归一化（裁边缩放）后的字形边长
_FONT_SIZE = 64       # 渲染字号
_MIN_COSINE = 0.35    # 余弦相似度低于该阈值视为匹配失败（保留原字符）

_HTTP_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    ),
    "Referer": "https://www.qidian.com/",
}

# ── 懒加载的全局缓存 ──────────────────────────────────────────────
_lock = threading.Lock()
_std_font: Optional[ImageFont.FreeTypeFont] = None
_std_chars: List[str] = []
_std_matrix: Optional[np.ndarray] = None      # (N, _CANVAS*_CANVAS) float32 单位向量
_mapping_cache: Dict[str, Dict[int, str]] = {}  # 字体 sha1 → {码点: 真实字}

logger = logging.getLogger("qidian_decrypt")


def _gb2312_level1_chars() -> List[str]:
    """生成 GB2312 一级汉字（3755 个常用字，按区位连续编码）。"""
    chars: List[str] = []
    for area in range(0xB0, 0xD8):            # 一级汉字区 16~55
        for pos in range(0xA1, 0xFF):         # 位 01~94
            try:
                chars.append(bytes([area, pos]).decode("gb2312"))
            except UnicodeDecodeError:
                continue
    return chars


def _find_std_font_path() -> Optional[str]:
    """在候选路径里找一个存在的标准字体。"""
    for path in _STD_FONT_CANDIDATES:
        if path and os.path.exists(path):
            return path
    return None


def _load_std_library() -> Tuple[List[str], np.ndarray]:
    """加载标准字库：渲染 GB2312 一级字，返回 (字符列表, 单位向量矩阵)。

    结果缓存在模块级变量中；首次调用约需数秒到十几秒。
    """
    global _std_font, _std_chars, _std_matrix
    with _lock:
        if _std_matrix is not None:
            return _std_chars, _std_matrix

        path = _find_std_font_path()
        if not path:
            raise RuntimeError(
                "未找到可用于字形匹配的标准中文字体，请安装 fonts-noto-cjk 或文泉驿"
            )

        font = ImageFont.truetype(path, _FONT_SIZE)
        chars = _gb2312_level1_chars()
        matrix = np.stack([_render_vector(ch, font) for ch in chars]).astype(np.float32)

        _std_font = font
        _std_chars = chars
        _std_matrix = matrix
        return chars, matrix


def _render_vector(ch: str, font: ImageFont.FreeTypeFont) -> np.ndarray:
    """把单个字符渲染成归一化单位向量（裁白边 → 缩放到 _GLYPH → 居中 → 归一化）。"""
    img = Image.new("L", (96, 96), 255)
    draw = ImageDraw.Draw(img)
    draw.text((12, 12), ch, font=font, fill=0)

    arr = np.asarray(img)
    ys, xs = np.where(arr < 200)
    if xs.size == 0:                                   # 字体无此字形
        return np.zeros(_CANVAS * _CANVAS, dtype=np.float32)

    x0, x1 = xs.min(), xs.max()
    y0, y1 = ys.min(), ys.max()
    crop = Image.fromarray(arr[y0:y1 + 1, x0:x1 + 1]).resize((_GLYPH, _GLYPH))

    canvas = Image.new("L", (_CANVAS, _CANVAS), 255)
    canvas.paste(crop, ((_CANVAS - _GLYPH) // 2, (_CANVAS - _GLYPH) // 2))

    vec = np.asarray(canvas, dtype=np.float32).ravel()
    vec = vec - vec.mean()
    norm = np.linalg.norm(vec)
    return (vec / norm) if norm > 1e-6 else vec


def _font_to_pil(font_bytes: bytes) -> ImageFont.FreeTypeFont:
    """把字体字节（woff2/ttf/otf）转成 PIL 可用的字体对象。"""
    try:
        font = TTFont(io.BytesIO(font_bytes))
        font.flavor = None                              # 去掉 woff2 包装，还原为 ttf
        buf = io.BytesIO()
        font.save(buf)
        buf.seek(0)
        return ImageFont.truetype(buf, _FONT_SIZE)
    except Exception:
        # 若 fontTools 无法解析，尝试直接作为 ttf/otf 加载
        return ImageFont.truetype(io.BytesIO(font_bytes), _FONT_SIZE)


def download_font(url: str, timeout: int = 15) -> bytes:
    """下载字体文件（公开 CDN，带 UA 与 Referer）。"""
    resp = requests.get(url, headers=_HTTP_HEADERS, timeout=timeout)
    resp.raise_for_status()
    return resp.content


def build_mapping(font_bytes: bytes, codepoints: Optional[set] = None) -> Dict[int, str]:
    """解析字体，建立 {码点: 真实汉字} 映射（仅匹配 codepoints 中出现的码点）。"""
    font = TTFont(io.BytesIO(font_bytes))
    cmap = font.getBestCmap()
    if not cmap:
        return {}

    std_chars, std_matrix = _load_std_library()
    pil_font = _font_to_pil(font_bytes)

    # 只处理正文里实际出现、且字体确实覆盖的码点
    targets = sorted(cmap.keys())
    if codepoints is not None:
        targets = [cp for cp in targets if cp in codepoints]

    # 1. 批量渲染所有目标字形（跳过无字形的码点）
    vecs: List[np.ndarray] = []
    valid_targets: List[int] = []
    for cp in targets:
        vec = _render_vector(chr(cp), pil_font)
        if not np.any(vec):
            continue                                    # 无字形，跳过
        vecs.append(vec)
        valid_targets.append(cp)

    if not vecs:
        return {}

    # 2. 一次矩阵乘法算所有相似度（比逐字 matvec 快一个数量级）
    char_matrix = np.stack(vecs).astype(np.float32)     # (N, _CANVAS*_CANVAS)
    sims = std_matrix @ char_matrix.T                   # (3755, N) 余弦相似度
    best_idx = np.argmax(sims, axis=0)                  # (N,)
    best_sim = sims[best_idx, np.arange(len(best_idx))]  # (N,)

    mapping: Dict[int, str] = {}
    for i, cp in enumerate(valid_targets):
        if best_sim[i] < _MIN_COSINE:
            continue                                    # 匹配不可靠，保留原字符
        mapping[cp] = std_chars[int(best_idx[i])]

    return mapping


def _apply_mapping(text: str, mapping: Dict[int, str]) -> str:
    """用映射替换文本中的乱码字符。"""
    if not mapping:
        return text
    out: List[str] = []
    for ch in text:
        out.append(mapping.get(ord(ch), ch))
    return "".join(out)


def decode_qidian(text: str, font_urls: List[str], timeout: int = 15) -> str:
    """解密起点乱码正文。

    Args:
        text: 从页面 innerText 读到的乱码正文。
        font_urls: 页面加载的字体文件 URL 列表（前端从 @font-face 提取）。

    Returns:
        解密后的明文（解密失败的字保留原字符，不影响其余部分）。
    """
    if not text or not font_urls:
        return text

    codepoints = {ord(ch) for ch in text}
    merged: Dict[int, str] = {}

    for url in font_urls:
        if not url or not url.strip():
            continue
        url = url.strip().strip("\"'")
        try:
            font_bytes = download_font(url, timeout=timeout)
        except Exception as e:
            logger.warning("下载字体失败 %s: %s", url, e)
            continue

        digest = hashlib.sha1(font_bytes).hexdigest()
        if digest in _mapping_cache:
            mapping = _mapping_cache[digest]
        else:
            try:
                mapping = build_mapping(font_bytes, codepoints=codepoints)
            except Exception as e:
                logger.warning("字体字形匹配失败 %s (%d bytes): %s", url, len(font_bytes), e)
                mapping = {}
            _mapping_cache[digest] = mapping

        merged.update(mapping)

    if merged:
        logger.info("解密完成：%d 个码点映射，原文 %d 字", len(merged), len(text))
    return _apply_mapping(text, merged)
