"""跨平台合并、风险识别、打分。纯函数，方便单独测试。"""
import re

# 不适合拿来做 AI 娱乐内容的话题。avoid = 默认隐藏，caution = 保留但提示
RISK_RULES = [
    (re.compile(r"遇难|身亡|死亡|丧生|去世|逝世|离世|罹难|伤亡|遗体|遗骸|自杀|轻生"), "avoid", "涉及死亡或伤亡"),
    (re.compile(r"地震|洪水|洪灾|台风|暴雨|火灾|爆炸|坍塌|塌方|事故|坠毁|坠楼|失事|泥石流|海啸|疫情|鼠疫|传染"), "avoid", "灾害、事故或疫情"),
    (re.compile(r"总书记|主席|总理|国务院|外交部|国防部|部长|政治局|人大|政协|两会|大使|领导人|官员|落马|被查|双开|纪委"), "avoid", "时政或官员"),
    (re.compile(r"战争|冲突|空袭|导弹|军演|袭击|恐袭|制裁|关税"), "avoid", "战争、冲突或国际政治"),
    (re.compile(r"警方|通报|被捕|刑拘|判刑|判决|死刑|嫌疑人|案件|命案|杀害|性侵|猥亵|拐卖|诈骗|电诈|涉诈|缅北|黑社会"), "avoid", "刑事案件或警情"),
    # 车牌号：指向具体个人
    (re.compile(r"[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼][A-HJ-NP-Z][·\s]?[A-HJ-NP-Z0-9]{4,5}"), "avoid", "指向具体个人（车牌号）"),
    (re.compile(r"儿童|幼儿|未成年|学生"), "caution", "涉及未成年人，做内容要格外谨慎"),
]


def risk_of(title: str) -> dict | None:
    for pattern, level, why in RISK_RULES:
        if pattern.search(title):
            return {"level": level, "why": why}
    return None


_PUNCT = re.compile(r"[#＃\s\"“”'‘’「」『』【】《》()（）·,，.。!！?？:：;；、…~\-—|]")


def norm(title: str) -> str:
    return _PUNCT.sub("", (title or "").lower())


def _bigrams(s: str) -> set[str]:
    return {s[i : i + 2] for i in range(len(s) - 1)}


def similar(a: str, b: str) -> bool:
    """字面相似：完全相同 / 短标题（≥4 字）被长标题包含 / 双字组重合度 ≥ 0.5。"""
    if a == b:
        return True
    s, l = (a, b) if len(a) <= len(b) else (b, a)
    if len(s) >= 4 and s in l:
        return True
    A, B = _bigrams(a), _bigrams(b)
    if not A or not B:
        return False
    return len(A & B) / len(A | B) >= 0.5


def cluster(entries):
    """entries: [(source, items)]，只处理热搜类。返回 [{title, keys, appearances}]。"""
    clusters = []
    for src, items in entries:
        if src.kind != "search":
            continue
        for it in items:
            key = norm(it.title)
            if not key:
                continue
            c = next((c for c in clusters if any(similar(k, key) for k in c["keys"])), None)
            if c is None:
                c = {"title": it.title, "keys": [], "appearances": []}
                clusters.append(c)
            c["keys"].append(key)
            if not any(a["source"] is src for a in c["appearances"]):
                c["appearances"].append({"source": src, "item": it, "key": key})
    return clusters


def score_cluster(c, history, now: float) -> dict:
    """
    排名分：各平台中最好的一个（按平台权重折算），第 1 名 100 分
    跨平台分：上榜平台的权重之和，满 4 个满权重平台为 100
    时效分：确认是新上榜的（追踪期间才出现）3 小时内 +60、12 小时内 +30；一小时内排名上升每名 +4
    总分 = 排名 × 0.5 + 跨平台 × 0.3 + 时效 × 0.2
    """
    apps = c["appearances"]
    rank_score = max(a["source"].weight * max(0, 51 - a["item"].rank) * 2 for a in apps)
    cross_score = min(sum(a["source"].weight for a in apps), 4) / 4 * 100

    first = history.first_seen(c["keys"])  # {"at", "known"} 或 None
    age_h = (now - first["at"]) / 3600 if first and first["known"] else None

    platforms, best_climb = [], 0
    for a in apps:
        ago = history.rank_hour_ago(a["source"].id, a["key"], now)  # None 不确定；0 一小时前不在榜上
        rank = a["item"].rank
        if ago is None:
            trend = None
        elif ago == 0:
            trend, climb = "新上榜", min(25, 51 - rank)
            best_climb = max(best_climb, climb)
        else:
            climb = ago - rank
            best_climb = max(best_climb, climb)
            trend = f"↑{climb}" if climb > 0 else f"↓{-climb}" if climb < 0 else "持平"
        platforms.append({"platform": a["source"].name, "source": a["source"].id, "rank": rank, "heat": a["item"].heat, "url": a["item"].url, "trend": trend})

    fresh_base = 60 if age_h is not None and age_h < 3 else 30 if age_h is not None and age_h < 12 else 0
    fresh_score = min(100, fresh_base + best_climb * 4)
    score = round(rank_score * 0.5 + cross_score * 0.3 + fresh_score * 0.2)
    return {
        "title": c["title"],
        "score": score,
        "platforms": platforms,
        "firstSeen": first["at"] if first and first["known"] else None,
        "fresh": age_h is not None and age_h < 3,
        "rising": best_climb >= 5,
        "risk": risk_of(c["title"]),
    }
