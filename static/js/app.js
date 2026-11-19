// =====================================================================
// AI 漫剧工作站 v2.0 前端逻辑
// =====================================================================
(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const CATEGORY_KEYS = ["characters_single", "characters_group", "scenes", "props"];
  const CATEGORY_LABEL = {
    characters_single: "单人人物",
    characters_group: "群像人物",
    scenes: "场景",
    props: "道具",
  };
  const ASSET_CATEGORY = {
    character_single: "characters_single",
    character_group: "characters_group",
    scene: "scenes",
    prop: "props",
  };
  const APP_VERSION = "v2.2";
  // 便携模式：直接双击 index.html 打开（file://），无需本地服务
  let DIRECT = location.protocol === "file:";
  const P = window.MANJU_PROMPTS || {};

  const state = {
    script: "",
    style: "ai_real",
    config: null,
    activeProvider: "deepseek",
    mock: false,
    assets: { characters_single: [], characters_group: [], scenes: [], props: [] },
    activeTab: "character_single",
    prompts: {},
    verifyReport: null,
    promptCat: "all",
    promptSearch: "",
    assetSearch: "",
    assetView: "all",
    epViewFilter: "__all__",
    storyboards: {},          // 集数 -> {text, groups, mock, time}
    currentEpisode: "",
    currentGroupIdx: -1,      // -1 = 全部
    selectedEpisodes: {},     // 多选生成：集数 -> true
    shareInfo: null,
    uidSeq: 1,
  };

  // ---------------- 基础工具 ----------------
  function uid() { return "a" + (state.uidSeq++); }

  function toast(msg, type = "") {
    const el = $("#toast");
    el.textContent = msg;
    el.className = "toast " + type;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.add("hidden"), 3000);
  }

  function copyText(text, okMsg) {
    const done = () => toast(okMsg || "已复制到剪贴板", "success");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); done(); } catch (e) { toast("复制失败，请手动选择复制", "error"); }
    document.body.removeChild(ta);
  }

  function friendlyError(msg) {
    let m = msg || "";
    if (/API Key/.test(m)) {
      m += "（可先开启左侧「演示模式」体验，或在模型配置页填写 Key 后保存）";
    } else if (/JSON|解析/.test(m)) {
      m += "（模型返回内容不是标准格式，已尝试自动修复一次；可换模型或调大 Max Tokens 重试）";
    } else if (/HTTP|401|403|404|429/.test(m)) {
      m += "（请核对 API Key 权限、模型名是否正确、额度是否充足）";
    } else if (/连接|超时|timeout|getaddrinfo/i.test(m)) {
      m += "（网络不通：国内网络可能无法直连 OpenAI 等海外接口，可改用 DeepSeek/豆包/Kimi 或配置代理）";
    }
    return m;
  }

  function showLogin() {
    $("#loginOverlay").classList.remove("hidden");
    $("#loginError").classList.add("hidden");
    $("#loginPassword").value = "";
    setTimeout(() => { try { $("#loginPassword").focus(); } catch (e) {} }, 60);
  }

  // ================= 便携模式：本地直连后端 =================
  function getLocalConfig() {
    const base = {
      active_provider: "deepseek",
      access_password: "",
      temperature: 0.8,
      max_tokens: 8192,
      prefix: P.defaultPrefix || {},
      providers: JSON.parse(JSON.stringify(P.providers || {})),
    };
    try {
      const saved = JSON.parse(localStorage.getItem("manju_config") || "{}");
      if (saved.providers) {
        for (const pid of Object.keys(base.providers)) {
          if (saved.providers[pid]) Object.assign(base.providers[pid], saved.providers[pid]);
        }
      }
      ["active_provider", "access_password", "temperature", "max_tokens", "prefix"].forEach((k) => {
        if (saved[k] !== undefined) base[k] = saved[k];
      });
    } catch (e) { /* ignore */ }
    return base;
  }

  function saveLocalConfig(cfg) {
    try { localStorage.setItem("manju_config", JSON.stringify(cfg)); } catch (e) { /* ignore */ }
  }

  function getLocalRules() {
    try {
      const saved = localStorage.getItem("manju_rules");
      if (saved) return saved;
    } catch (e) { /* ignore */ }
    return P.rules || "";
  }

  function saveLocalRules(text) {
    try { localStorage.setItem("manju_rules", text); } catch (e) { /* ignore */ }
  }

  function clearLocalRules() {
    try { localStorage.removeItem("manju_rules"); } catch (e) { /* ignore */ }
  }

  function extractJson(text) {
    if (!text) throw new Error("模型返回为空");
    text = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const s = text.indexOf("{"), e = text.lastIndexOf("}");
    if (s === -1 || e <= s) throw new Error("模型输出中没有找到 JSON：" + text.slice(0, 200));
    try { return JSON.parse(text.slice(s, e + 1)); }
    catch (err) { throw new Error("JSON 解析失败：" + err.message + "。原始内容：" + text.slice(0, 300)); }
  }

  async function callLLM(providerId, system, user, temperature, maxTokens) {
    const cfg = getLocalConfig();
    const p = cfg.providers[providerId];
    if (!p) throw new Error("未找到该模型厂商配置");
    if (p.direct === false) {
      throw new Error("「" + p.name + "」暂不支持浏览器直连（跨域限制）。请改用 DeepSeek / 通义千问 / Kimi / 智谱，或使用本地服务版。");
    }
    if (!p.base_url) throw new Error("请先填写 API 地址（Base URL）");
    if (!p.api_key) throw new Error("请先填写 API Key（也可以在左侧开启演示模式，无需 Key）");
    if (!p.model) throw new Error("请先填写模型名称");
    const omitTemp = /reasoner|r1/i.test(p.model);
    const payload = {
      model: p.model,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      max_tokens: maxTokens || cfg.max_tokens || 8192,
      stream: false,
    };
    if (!omitTemp) payload.temperature = temperature !== undefined ? temperature : cfg.temperature;
    let resp;
    try {
      resp = await fetch(p.base_url.replace(/\/+$/, "") + "/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + p.api_key },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      throw new Error("无法连接 " + p.base_url + "：" + e.message + "（浏览器直连被网络或跨域拦截，可改用演示模式或本地服务版）");
    }
    let data;
    try { data = await resp.json(); } catch (e) { throw new Error("服务返回异常 HTTP " + resp.status); }
    if (!resp.ok) {
      const msg = (data.error && (data.error.message || data.error)) || JSON.stringify(data).slice(0, 300);
      throw new Error("请求 " + p.base_url + "/chat/completions 返回错误 HTTP " + resp.status + "：" + msg);
    }
    const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) throw new Error("模型未返回内容");
    return content;
  }

  async function extractJsonOrRetry(providerId, system, user, temperature, maxTokens, retries = 1, retryNote = "") {
    let last;
    for (let i = 0; i <= retries; i++) {
      try {
        const raw = await callLLM(providerId, system, user, temperature, maxTokens);
        return extractJson(raw);
      } catch (e) {
        last = e;
        if (i < retries && /JSON|没有找到/.test(e.message)) {
          user += "\n\n" + (retryNote || "【重要】你上次的输出无法解析为 JSON。请只输出一个合法的 JSON 对象，不要包含任何其他文字、解释或代码块标记。");
        }
      }
    }
    throw last;
  }

  const STRONG_RETRY_NOTE = "【重要】你上次的输出严重超长被截断，导致 JSON 不完整。请立即精简：每个资产总字数不超过 120 字（核心主角可到 200 字），所有资产合计控制在 4000 字以内，确保 JSON 完整闭合，只输出 JSON，不要输出任何其他内容。";

  async function extractChunked(providerId, system, episodes, chunkSize, style, keys, retryNote) {
    const merged = {};
    keys.forEach((k) => { merged[k] = []; });
    const chunks = [];
    for (let i = 0; i < episodes.length; i += chunkSize) chunks.push(episodes.slice(i, i + chunkSize));
    for (let ci = 0; ci < chunks.length; ci++) {
      const seg = chunks[ci].map((e) => e.name + "\n" + e.script).join("\n\n");
      const user = "制作风格：" + style + "\n\n剧本片段（请只拆分此片段内的资产，角色名保持全局一致）：\n" + seg;
      const r = await extractJsonOrRetry(providerId, system, user, 0.3, 32768, 2, retryNote);
      keys.forEach((k) => { merged[k] = merged[k].concat(r[k] || []); });
    }
    return merged;
  }

  function parseDialogues(script) {
    const out = [];
    String(script || "").split(/\r?\n/).forEach((ln) => {
      const m = ln.match(/^([^：:]{1,12})[：:]\s*(.+)$/);
      if (m) {
        const name = cleanSpeakerName(m[1]);
        if (!name) return;
        if (P.headersToSkip.indexOf(name) !== -1) return;
        const text = m[2].trim().replace(/^["“”]|["“”]$/g, "");
        if (text) out.push({ name, text });
      }
    });
    return out;
  }

  const NAME_BAD_WORDS = [
    "拍", "走", "看", "握", "闪", "盯", "跪", "站", "坐", "笑", "说", "喝", "喊", "指",
    "拉", "扶", "抱", "推", "抓", "提", "举", "望", "低", "抬", "转", "点", "摇", "皱",
    "奔", "冲", "退", "砍", "刺", "挡", "躲", "跳", "哭", "怒", "惊", "听", "闻", "响",
    "茅屋", "房间", "街道", "天台", "宫殿", "沙滩", "雪花", "刀光", "声音", "人群", "众人",
    "官兵", "远处", "忽然", "传来", "画面", "场景", "镜头", "字幕", "背景", "环境",
    "所需", "材料", "特性", "原因", "结果", "方法", "系统", "提示", "情况", "问题", "要求",
  ];
  const CHARACTER_IGNORE = ["系统", "系统OS", "系统提示", "旁白", "画外音", "内心", "内心OS", "所需材料", "特性", "材料", "提示", "OS"];
  function cleanSpeakerName(raw) {
    let name = String(raw || "").replace(/[（(【\[][^）)】\]]*[）)】\]]/g, "").replace(/[，,。！？!?：:、\s]/g, "");
    name = name.replace(/(OS|内心|旁白|独白|心声)$/i, "");
    if (!name || name.length > 8) return null;
    if (CHARACTER_IGNORE.indexOf(name) !== -1) return null;
    for (const w of NAME_BAD_WORDS) {
      if (name.indexOf(w) !== -1) return null;
    }
    return name;
  }

  const CN_DIGITS = { "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10, "百": 100 };
  function cnToInt(s) {
    if (!s) return null;
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    let total = 0, num = 0;
    for (const ch of String(s)) {
      const v = CN_DIGITS[ch];
      if (!v) return null;
      if (v === 100) { total += num * 100; num = 0; }
      else if (v === 10) { if (num === 0) num = 1; total += num * 10; num = 0; }
      else num = v;
    }
    total += num;
    return total || null;
  }
  function splitEpisodes(script) {
    const segments = [];
    let curName = null, curLines = [];
    const flush = () => {
      if (curName && curLines.some((l) => l.trim())) segments.push({ name: curName, script: curLines.join("\n") });
      curName = null; curLines = [];
    };
    String(script || "").split(/\r?\n/).forEach((ln) => {
      const m = ln.match(/^\s*[【\[]?\s*第\s*([一二三四五六七八九十百\d]+)\s*[集章话]/);
      if (m) {
        flush();
        const n = cnToInt(m[1]);
        curName = n ? "第" + n + "集" : "第" + m[1] + "集";
        curLines = [ln];
      } else if (curName) {
        curLines.push(ln);
      }
    });
    flush();
    return segments;
  }
  function sceneHeaders(script) {
    const out = [];
    String(script || "").split(/\r?\n/).forEach((ln) => {
      const m = ln.trim().match(/^(\d{1,3})\s*[-－—]\s*(\d{1,3})\s*[日夜]?\s*[内外]\s*(.+?)[。．\s]*$/);
      if (m && m[3].trim()) {
        out.push({ ep: parseInt(m[1], 10), no: parseInt(m[2], 10), name: m[3].trim() });
      }
    });
    return out;
  }

  function mockAnalyze(script) {
    const dialogues = parseDialogues(script);
    const speakers = [];
    dialogues.forEach((d) => { if (speakers.indexOf(d.name) === -1) speakers.push(d.name); });
    if (!speakers.length) speakers.push("主角");
    const scenes = [], props = [];
    sceneHeaders(script).forEach((hs) => { if (scenes.indexOf(hs.name) === -1) scenes.push(hs.name); });
    String(script || "").split(/\r?\n/).forEach((ln) => {
      if (!scenes.length) {
        P.sceneKeywords.forEach((k) => { if (ln.indexOf(k) !== -1 && scenes.indexOf(k) === -1) scenes.push(k); });
      }
      P.propKeywords.forEach((k) => { if (ln.indexOf(k) !== -1 && props.indexOf(k) === -1) props.push(k); });
    });
    if (!scenes.length) scenes.push("故事发生的主场景");
    const characters_single = speakers.slice(0, 8).map((sp, i) => ({
      name: sp, category: "character_single",
      level: i === 0 ? "核心主角" : "次要配角",
      age: "年龄由剧本决定", body: "身高体态依据剧本描述", face: "脸型五官依据剧本描述",
      hairstyle: "发型发色依据剧本描述", outfit: "穿搭细节依据剧本描述",
      temperament: "气质人设依据剧本表现", script_actions: "仅保留剧本中出现的动作",
      features: "人物专属特征依据剧本设定",
      description: "人物资产：" + sp + "，仅描述人物本身（外貌、体型、发型、穿搭、气质、剧本原文动作），不含任何场景与道具。",
      keywords: [sp, "人物"], script_ref: "剧本中有台词或关键戏份",
    }));
    const characters_group = [];
    if (speakers.length >= 2) {
      characters_group.push({
        name: "主要角色群像", category: "character_group", level: "路人NPC/群像",
        description: "群像画面：" + speakers.slice(0, 4).join("、") + " 同框，人物站位与关系依据剧本设定，普通大众面容、不美化，无场景无道具。",
        keywords: ["群像", "同框"], script_ref: "剧本存在多角色同框情节",
      });
    }
    return {
      characters_single,
      characters_group,
      scenes: scenes.slice(0, 30).map((sc) => ({
        name: sc, category: "scene",
        description: "场景「" + sc + "」：依据剧本场次编号与氛围呈现空间结构、环境、光线与天气，画面干净，不出现任何人物。",
        keywords: [sc], script_ref: "剧本场次中出现该场景（同名场景已合并）",
      })),
      props: props.slice(0, 8).map((pp) => ({
        name: pp, category: "prop",
        description: "道具「" + pp + "」：依据剧本设定呈现材质、颜色、尺寸、造型与新旧状态，纯物品描述，无人物无场景。",
        keywords: [pp], script_ref: "剧本中出现该物品",
      })),
    };
  }

  function buildForbiddenMap(assets) {
    const byCat = { character_single: [], character_group: [], scene: [], prop: [] };
    (assets || []).forEach((a) => { if (byCat[a.category]) byCat[a.category].push(a); });
    const chars = byCat.character_single.concat(byCat.character_group);
    const words = (items) => {
      const out = [];
      items.forEach((it) => {
        if (it.name) out.push(it.name);
        (it.keywords || []).forEach((k) => { if (String(k).trim()) out.push(String(k).trim()); });
      });
      return out;
    };
    return {
      character_single: words(byCat.scene).concat(words(byCat.prop)),
      character_group: words(byCat.scene).concat(words(byCat.prop)),
      scene: words(chars).concat(words(byCat.prop)),
      prop: words(chars).concat(words(byCat.scene)),
    };
  }

  const ACTION_WORDS = [
    "站在", "坐下", "站起身来", "走来", "走去", "走过来", "走过去", "跪在", "跪着", "看着",
    "望向", "看向", "微笑", "笑着", "握住", "拿起", "放下", "转头", "抬头", "低头", "点头",
    "摇头", "皱眉", "奔跑", "挥手", "指着", "抱住", "扶起", "蹲下", "跳起", "冲过去", "退后",
    "开口说", "伸手", "转身", "踏步", "迈步", "举起", "拔出", "抽出",
  ];

  function mockGeneratePrompt(asset, style, prefix) {
    const base = (prefix || "").replace("{style}", style).replace("{type}", P.assetTypeLabel[asset.category] || "")
      .replace("{name}", asset.name || "").replace("{description}", asset.description || "")
      .replace("{reference}", asset._ref || "");
    return [
      { text: base, note: "演示模式生成（强调主体）" },
      { text: base + "，构图紧凑，视觉重心明确。", note: "演示模式生成（强调构图）" },
      { text: base + "，光线层次细腻，质感真实。", note: "演示模式生成（强调质感）" },
    ];
  }

  function mockVerify(script, assets) {
    const names = new Set(parseDialogues(script).map((d) => d.name));
    const have = new Set((assets || []).map((a) => a.name));
    const missing = Array.from(names).filter((n) => !have.has(n));
    const issues = missing.slice(0, 5).map((n) => ({
      type: "missing", level: "high",
      detail: "角色「" + n + "」在剧本中有台词，但资产清单中未找到对应单人人物。",
      suggestion: "手动添加该角色，或点击「应用建议」自动补齐。",
    }));
    issues.push({
      type: "cross_contamination", level: "low",
      detail: "演示模式仅做基础检查；接入真实模型（DeepSeek 等）后可对全部描述做深度校验。",
      suggestion: "在模型配置页填写 API Key 后重新运行校验。",
    });
    return {
      summary: "演示模式：基础清单共 " + assets.length + " 项资产；建议接入真实模型做深度校验。",
      issues,
      missing_suggestions: missing.slice(0, 5).map((n) => ({
        category: "character_single", name: n, reason: "剧本中有台词", description_hint: "依据剧本补充该角色的视觉描述",
      })),
    };
  }

  function mockStoryboard(script) {
    const dialogues = parseDialogues(script);
    let scene = "主场景";
    String(script || "").split(/\r?\n/).forEach((ln) => {
      if (scene === "主场景") {
        P.sceneKeywords.forEach((k) => { if (ln.indexOf(k) !== -1) scene = k; });
      }
    });
    const speakers = Array.from(new Set(dialogues.map((d) => d.name)));
    const group = (idx, char, lineText, tone) =>
      "第" + idx + "组\n位置状态与场景：\n【" + scene + "，" + char + "位于画面中心，当前状态延续上一组，动作起点明确，氛围贴合剧情】\n" +
      "镜头1：\n【中景】，【缓推】，【平视】，【正面机位】，【3秒】。\n" +
      "【" + char + "立于场景之中，视线看向画外方向，状态" + tone + "，表情层次清晰，背景保持干净】\n" +
      "特效/环境动态：\n【无明显特效，保持画面干净，以人物状态和构图承接氛围】\n" +
      "台词：\n" + char + "（" + tone + "）：\n\"" + lineText + "\"\n" +
      "总时长： 5秒。\n衔接提示： 动作与视线自然过渡到下一组。\n本组情绪重点： " + tone + "。\n" +
      "本组视觉重点： 以人物表演与构图形成主视觉。\n时长校验说明： 台词时长合理，本组已控制在15秒内。\n";
    const parts = [];
    if (dialogues.length) {
      const tones = ["语气低沉，情绪克制", "语气平静，节奏放缓", "语气坚定，情绪渐强"];
      dialogues.slice(0, 3).forEach((d, i) => parts.push(group(i + 1, d.name, d.text, tones[i % 3])));
    } else {
      parts.push(group(1, speakers[0] || "主角", "（本段无对白，靠画面与动作推进）", "无言，神态专注"));
    }
    return parts.join("\n");
  }

  function mockShotPrompt(userShot) {
    const shot = String(userShot || "").trim();
    const dialogues = parseDialogues(shot);
    const lines = shot.split(/\r?\n/).filter((l) => l.trim() && l.indexOf("：") === -1 && l.indexOf(":") === -1);
    const position = lines[0] || shot.slice(0, 80);
    const out = [
      "位置状态与场景：",
      "【依据用户草稿整理：" + position.slice(0, 120) + "】",
      "镜头1：",
      "【中景】，【固定】，【平视】，【正面机位】，【4秒】。",
      "【" + shot.slice(0, 260) + "】",
      "特效/环境动态：",
      "【无明显特效，保持画面干净，以人物状态和构图承接氛围】",
    ];
    if (dialogues.length) {
      out.push("台词：");
      out.push(dialogues[0].name + "（语气依据草稿）：\n\"" + dialogues[0].text + "\"");
    }
    return out.join("\n");
  }

  async function directTest(body) {
    const providerId = body.provider_id || state.activeProvider;
    const cfg = getLocalConfig();
    const p = cfg.providers[providerId];
    if (body.base_url !== undefined) p.base_url = body.base_url;
    if (body.api_key !== undefined) p.api_key = body.api_key;
    if (body.model !== undefined) p.model = body.model;
    if (!p.api_key) throw new Error("请先填写 API Key（也可以在左侧开启演示模式，无需 Key）");
    const text = await callLLM(providerId, "你是一个连通性测试助手。", "请只回复两个字：正常。", 0.1, 50);
    return { ok: true, reply: text.trim().slice(0, 200) };
  }

  async function directApi(path, body) {
    if (path === "/api/analyze") {
      const style = P.stylePresets[body.style] ? P.stylePresets[body.style].style : "AI真人实拍风格";
      if (body.mock) return { ok: true, assets: mockAnalyze(body.script), count: countAssets(mockAnalyze(body.script)), mock: true };
      const user = "制作风格：" + style + "\n\n剧本：\n" + body.script;
      let data;
      const pid = body.provider_id || "deepseek";
      if (String(body.script || "").length > 1200) {
        const eps = splitEpisodes(body.script);
        if (eps.length > 8) {
          // 超长多集剧本：按集分批提取，保证不截断
          const chars = await extractChunked(pid, P.analyzeSystemChars, eps, 8, style, ["characters_single", "characters_group"], STRONG_RETRY_NOTE);
          const env = await extractChunked(pid, P.analyzeSystemEnv, eps, 8, style, ["scenes", "props"], STRONG_RETRY_NOTE);
          data = {
            characters_single: chars.characters_single || [],
            characters_group: chars.characters_group || [],
            scenes: env.scenes || [],
            props: env.props || [],
          };
        } else {
          // 长剧本并行拆两次
          const [chars, env] = await Promise.all([
            extractJsonOrRetry(pid, P.analyzeSystemChars, user, 0.3, 32768, 2, STRONG_RETRY_NOTE),
            extractJsonOrRetry(pid, P.analyzeSystemEnv, user, 0.3, 32768, 2, STRONG_RETRY_NOTE),
          ]);
          data = {
            characters_single: chars.characters_single || [],
            characters_group: chars.characters_group || [],
            scenes: env.scenes || [],
            props: env.props || [],
          };
        }
      } else {
        try {
          data = await extractJsonOrRetry(pid, P.analyzeSystem, user, 0.3, 32768, 2, STRONG_RETRY_NOTE);
        } catch (e) {
          const [chars, env] = await Promise.all([
            extractJsonOrRetry(pid, P.analyzeSystemChars, user, 0.3, 32768, 2, STRONG_RETRY_NOTE),
            extractJsonOrRetry(pid, P.analyzeSystemEnv, user, 0.3, 32768, 2, STRONG_RETRY_NOTE),
          ]);
          data = {
            characters_single: chars.characters_single || [],
            characters_group: chars.characters_group || [],
            scenes: env.scenes || [],
            props: env.props || [],
          };
        }
      }
      const assets = {
        characters_single: data.characters_single || [],
        characters_group: data.characters_group || [],
        scenes: data.scenes || [],
        props: data.props || [],
      };
      return { ok: true, assets, count: countAssets(assets), mock: false };
    }
    if (path === "/api/generate_prompt") {
      const asset = body.asset || {};
      const style = P.stylePresets[body.style] ? P.stylePresets[body.style].style : "";
      if (body.mock) return { ok: true, prompts: mockGeneratePrompt(asset, style, body.prefix), isolation: { clean: true, warnings: [] }, mock: true };
      const user = "风格：" + style + "\n前缀词模板：" + (body.prefix || "") + "\n资产类型：" + (P.assetTypeLabel[asset.category] || "") +
        "\n资产名称：" + (asset.name || "") + "\n资产视觉描述：" + (asset.description || "") + "\n用户参考词：" + (body.reference_words || "（无）");
      const data = await extractJsonOrRetry(body.provider_id || "deepseek", P.generateSystem, user, 0.8, 2048);
      const prompts = data.prompts || [];
      const forbidden = buildForbiddenMap(body.assets || [])[asset.category] || [];
      const warnings = [];
      const seen = new Set();
      prompts.forEach((p) => {
        (forbidden || []).forEach((w) => {
          if (w && w.length >= 2 && (p.text || "").indexOf(w) !== -1 && !seen.has(w)) { seen.add(w); warnings.push({ word: w, category: asset.category }); }
        });
        if (asset.category === "character_single" || asset.category === "character_group") {
          ACTION_WORDS.forEach((w) => {
            if ((p.text || "").indexOf(w) !== -1 && !seen.has(w)) { seen.add(w); warnings.push({ word: w, category: asset.category, kind: "action" }); }
          });
        }
      });
      return { ok: true, prompts, isolation: { clean: warnings.length === 0, warnings }, mock: false };
    }
    if (path === "/api/verify") {
      if (body.mock) return { ok: true, report: mockVerify(body.script, body.assets), mock: true };
      const style = P.stylePresets[body.style] ? P.stylePresets[body.style].label : "";
      const user = "制作风格：" + style + "\n\n剧本：\n" + body.script + "\n\n当前资产清单（JSON）：\n" + JSON.stringify(body.assets);
      const report = await extractJsonOrRetry(body.provider_id || "deepseek", P.verifySystem, user, 0.3, 16384, 2);
      return { ok: true, report, mock: false };
    }
    if (path === "/api/storyboard") {
      const style = P.stylePresets[body.style] ? P.stylePresets[body.style].label : "";
      let eps = splitEpisodes(body.script);
      if (!eps.length) eps = [{ name: body.episode_label || "第1集", script: body.script }];
      if (body.episodes && Array.isArray(body.episodes) && body.episodes.length) {
        const wanted = eps.filter((e) => body.episodes.indexOf(e.name) !== -1);
        if (wanted.length) eps = wanted;
      } else if (body.episode) {
        const wanted = eps.filter((e) => e.name === body.episode);
        if (wanted.length) eps = wanted;
      }
      const results = [];
      const pid = body.provider_id || "deepseek";
      if (body.mock) {
        for (const e of eps) results.push({ name: e.name, text: mockStoryboard(e.script) });
      } else {
        // 多集并行生成（最多3路），大幅提速
        const limit = Math.min(3, Math.max(1, eps.length));
        let i = 0;
        const worker = async () => {
          while (i < eps.length) {
            const idx = i++;
            const e = eps[idx];
            const text = await callLLM(
              pid,
              P.storyboardHead + getLocalRules() + P.storyboardTail,
              "制作风格：" + style + "\n\n这是「" + e.name + "」的完整剧本。请只针对本集内容生成分镜，组号从第1组重新开始，只输出本集内容，不要输出其它集数。\n\n剧本：\n" + e.script,
              0.8, 16384
            );
            results[idx] = { name: e.name, text: text.trim().replace(/^```(?:text|markdown)?\s*/i, "").replace(/\s*```$/, "") };
          }
        };
        await Promise.all(Array.from({ length: limit }, worker));
      }
      const merged = results.map((r) => r.name + "\n" + r.text).join("\n\n");
      return { ok: true, text: merged, episodes: results, mock: !!body.mock };
    }
    if (path === "/api/storyboard_prompt") {
      const style = P.stylePresets[body.style] ? P.stylePresets[body.style].label : "";
      const userShot = String(body.user_shot || "").trim();
      if (!userShot) throw new Error("分镜草稿不能为空");
      if (body.mock) {
        return { ok: true, text: mockShotPrompt(userShot), mock: true };
      }
      const system = P.storyboardHead + getLocalRules() +
        "\n\n【用户自定义分镜优化示例】\n用户草稿：\n" + P.shotExampleInput +
        "\n\n优化结果：\n" + P.shotExampleOutput +
        "\n\n【本次任务】用户对某组分镜不满意，提供了自己的分镜草稿。请在不改变剧情核心、不修改原台词的前提下，把草稿优化为符合上述固定格式、可直接用于即梦生成的分镜提示词：必须包含 位置状态与场景 / 镜头N（景别、运镜、角度、机位、时长、画面内容）/ 特效·环境动态 / 台词（原台词一字不改）。只输出优化结果，不要解释规则。";
      const text = await callLLM(body.provider_id || "deepseek", system, "制作风格：" + style + "\n\n用户的分镜草稿：\n" + userShot, 0.7, 4096);
      return { ok: true, text: text.trim().replace(/^```(?:text|markdown)?\s*/i, "").replace(/\s*```$/, ""), mock: false };
    }
    if (path === "/api/test") return directTest(body);
    if (path === "/api/config") {
      const cfg = getLocalConfig();
      if (body.active_provider) cfg.active_provider = body.active_provider;
      if (body.access_password !== undefined) cfg.access_password = String(body.access_password).trim();
      if (body.providers) {
        Object.keys(body.providers).forEach((pid) => {
          if (cfg.providers[pid]) Object.assign(cfg.providers[pid], body.providers[pid]);
        });
      }
      if (body.temperature !== undefined) cfg.temperature = Number(body.temperature);
      if (body.max_tokens !== undefined) cfg.max_tokens = Number(body.max_tokens);
      if (body.prefix) Object.assign(cfg.prefix, body.prefix);
      saveLocalConfig(cfg);
      return { ok: true, config: cfg };
    }
    if (path === "/api/rules") {
      if (body.reset) clearLocalRules();
      else if (body.rules) saveLocalRules(String(body.rules));
      return { ok: true, rules: getLocalRules() };
    }
    if (path === "/api/info") return { ok: true, mode: "portable", local_url: "本文件", lan_urls: [], password_required: false };
    if (path === "/api/login") return { ok: true };
    throw new Error("便携模式不支持该接口：" + path);
  }

  function countAssets(assets) {
    return Object.keys(assets).reduce((n, k) => n + (assets[k] ? assets[k].length : 0), 0);
  }

  async function api(path, body) {
    if (DIRECT) return directApi(path, body);
    let resp;
    try {
      resp = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
      });
    } catch (e) {
      throw new Error("无法连接本地服务：请重新双击「启动工作站.bat」启动，并保持黑色窗口打开");
    }
    let data;
    try { data = await resp.json(); } catch (e) { throw new Error("服务返回异常，请重启工作站"); }
    if (resp.status === 401 && data.code === "AUTH_REQUIRED") {
      showLogin();
      throw new Error("需要访问密码");
    }
    if (!data.ok) throw new Error(data.error || "请求失败");
    return data;
  }

  function flattenAssets() {
    return CATEGORY_KEYS.flatMap((k) => state.assets[k]);
  }

  function saveLocal() {
    try {
      localStorage.setItem("manju_state", JSON.stringify({
        script: state.script,
        style: state.style,
        mock: state.mock,
        activeProvider: state.activeProvider,
        assets: state.assets,
        prompts: state.prompts,
        verifyReport: state.verifyReport,
        storyboards: state.storyboards,
        currentEpisode: state.currentEpisode,
        uidSeq: state.uidSeq,
      }));
    } catch (e) { /* ignore */ }
  }

  function loadLocal() {
    try {
      const raw = localStorage.getItem("manju_state");
      if (!raw) return;
      const s = JSON.parse(raw);
      Object.assign(state, {
        script: s.script || "",
        style: s.style || "ai_real",
        mock: !!s.mock,
        activeProvider: s.activeProvider || "deepseek",
        assets: Object.assign({ characters_single: [], characters_group: [], scenes: [], props: [] }, s.assets),
        prompts: s.prompts || {},
        verifyReport: s.verifyReport || null,
        storyboards: s.storyboards || {},
        currentEpisode: s.currentEpisode || "",
        uidSeq: s.uidSeq || 1,
      });
    } catch (e) { /* ignore */ }
  }

  // ---------------- 步骤导航 ----------------
  const STEP_IDS = [1, 2, 3, 4, 5, 6, 7];
  function goStep(n) {
    STEP_IDS.forEach((i) => {
      $("#step-" + i).classList.toggle("active", i === n);
      const btn = document.querySelector(`.step-btn[data-step="${i}"]`);
      if (btn) {
        btn.classList.toggle("active", i === n);
        btn.classList.toggle("done", i < n);
      }
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
    if (n === 7) renderEpisodeSelectLocal();
    if (n === 5) renderPromptAssetList();
    saveLocal();
  }

  $$(".step-btn").forEach((btn) => {
    btn.addEventListener("click", () => goStep(Number(btn.dataset.step)));
  });
  $$("[data-goto]").forEach((btn) => {
    btn.addEventListener("click", () => goStep(Number(btn.dataset.goto)));
  });

  // ---------------- 登录 ----------------
  $("#loginBtn").addEventListener("click", async () => {
    const pw = $("#loginPassword").value;
    try {
      const data = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw }),
      });
      const body = await data.json();
      if (body.ok) {
        toast("欢迎回来", "success");
        location.reload();
      } else {
        $("#loginError").textContent = body.error || "密码错误";
        $("#loginError").classList.remove("hidden");
      }
    } catch (e) {
      $("#loginError").textContent = "无法连接服务，请确认工作站已启动";
      $("#loginError").classList.remove("hidden");
    }
  });
  $("#loginPassword").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#loginBtn").click();
  });

  // ---------------- 配置加载 ----------------
  async function loadConfig() {
    if (DIRECT) {
      state.config = getLocalConfig();
      state.activeProvider = state.config.active_provider || "deepseek";
      renderProviderSelect();
      fillProviderFields();
      $("#temperatureInput").value = state.config.temperature;
      $("#maxTokensInput").value = state.config.max_tokens;
      $("#accessPassword").value = state.config.access_password || "";
      $$(".prefix-input").forEach((ta) => {
        ta.value = (state.config.prefix || {})[ta.dataset.prefix] || "";
      });
      updateProviderBadge();
      updateShareInfo();
      return;
    }
    const resp = await fetch("/api/config");
    if (resp.status === 401) { showLogin(); return; }
    const data = await resp.json();
    state.config = data.config;
    state.activeProvider = data.config.active_provider || "deepseek";
    renderProviderSelect();
    fillProviderFields();
    $("#temperatureInput").value = data.config.temperature;
    $("#maxTokensInput").value = data.config.max_tokens;
    $("#accessPassword").value = data.config.access_password || "";
    $$(".prefix-input").forEach((ta) => {
      ta.value = (data.config.prefix || {})[ta.dataset.prefix] || "";
    });
    updateProviderBadge();
    updateShareInfo();
  }

  function renderProviderSelect() {
    const sel = $("#providerSelect");
    sel.innerHTML = "";
    Object.entries(state.config.providers).forEach(([id, p]) => {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = p.name;
      sel.appendChild(opt);
    });
    sel.value = state.activeProvider;
  }

  function fillProviderFields() {
    const p = state.config.providers[state.activeProvider] || {};
    $("#baseUrlInput").value = p.base_url || "";
    $("#apiKeyInput").value = p.api_key || "";
    $("#modelInput").value = p.model || "";
    $("#modelInput").placeholder =
      state.activeProvider === "doubao"
        ? "火山方舟推理接入点 ID（ep-…）或已开通的模型名"
        : "如 deepseek-chat";
    const dl = $("#modelList");
    dl.innerHTML = "";
    (p.models || []).forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m;
      dl.appendChild(opt);
    });
    updateProviderBadge();
  }

  function updateProviderBadge() {
    const p = state.config ? state.config.providers[state.activeProvider] : null;
    const badge = $("#providerBadge");
    if (!p) { badge.textContent = "未配置模型"; badge.className = "provider-badge"; return; }
    const keySet = p.api_key && p.api_key.trim();
    badge.textContent = state.mock
      ? "演示模式（本地模拟）"
      : (keySet ? p.name + " · " + (p.model || "") : p.name + " · 未填 Key");
    badge.className = "provider-badge" + (keySet || state.mock ? " ok" : "");
  }

  async function updateShareInfo() {
    if (DIRECT) {
      $("#shareStatus").textContent = "便携版 · 无需本地服务";
      $("#shareStatus").className = "share-status public";
      $("#shareMode").textContent = "便携文件";
      $("#shareLocal").textContent = "双击本文件即可打开";
      $("#shareLan").textContent = "—";
      $("#shareTip").textContent = "把本文件复制到任何电脑，双击即可使用（演示模式离线可用；真实模型需在模型配置页填写 Key）";
      return;
    }
    try {
      const resp = await fetch("/api/info");
      if (!resp.ok) return;
      const info = await resp.json();
      state.shareInfo = info;
      const status = $("#shareStatus");
      if (info.mode === "lan") {
        status.textContent = "局域网分享中" + (info.password_required ? " · 已设密码" : " · 未设密码");
        status.className = "share-status lan";
      } else {
        status.textContent = "仅本机访问";
        status.className = "share-status";
      }
      $("#shareMode").textContent = info.mode === "lan" ? "局域网可访问" : "仅本机";
      $("#shareLocal").textContent = info.local_url || "";
      $("#shareLan").textContent = (info.lan_urls || []).join("  ") || "—";
      $("#shareTip").textContent = info.mode === "lan"
        ? "把上面的局域网地址发给同一网络的人即可访问；外网访问请用「公网分享.bat」"
        : "如需分享给他人：关闭本窗口，改用「分享给局域网.bat」或「公网分享.bat」启动";
    } catch (e) { /* ignore */ }
  }

  $("#providerSelect").addEventListener("change", (e) => {
    state.activeProvider = e.target.value;
    fillProviderFields();
    saveLocal();
  });

  $("#saveConfig").addEventListener("click", async () => {
    try {
      const p = state.config.providers[state.activeProvider];
      p.base_url = $("#baseUrlInput").value.trim();
      p.api_key = $("#apiKeyInput").value.trim();
      p.model = $("#modelInput").value.trim();
      const body = {
        active_provider: state.activeProvider,
        providers: state.config.providers,
        temperature: parseFloat($("#temperatureInput").value) || 0.8,
        max_tokens: parseInt($("#maxTokensInput").value, 10) || 8192,
      };
      const data = await api("/api/config", body);
      state.config = data.config;
      toast("配置已保存", "success");
      updateProviderBadge();
      saveLocal();
    } catch (e) {
      toast("保存失败：" + e.message, "error");
    }
  });

  $("#testConnection").addEventListener("click", async () => {
    const btn = $("#testConnection");
    btn.disabled = true;
    btn.textContent = "测试中…";
    try {
      const provider_id = $("#providerSelect").value;
      const base_url = $("#baseUrlInput").value.trim();
      const api_key = $("#apiKeyInput").value.trim();
      const model = $("#modelInput").value.trim();
      const data = await api("/api/test", { provider_id, base_url, api_key, model });
      const p = state.config.providers[provider_id];
      p.base_url = base_url;
      p.api_key = api_key;
      p.model = model;
      const saved = await api("/api/config", {
        active_provider: provider_id,
        providers: state.config.providers,
        temperature: parseFloat($("#temperatureInput").value) || 0.8,
        max_tokens: parseInt($("#maxTokensInput").value, 10) || 8192,
      });
      state.config = saved.config;
      state.activeProvider = provider_id;
      updateProviderBadge();
      saveLocal();
      toast("连接正常：" + (data.reply || "OK") + "，配置已自动保存", "success");
    } catch (e) {
      toast("测试失败：" + friendlyError(e.message), "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "测试连接";
    }
  });

  $("#saveShare").addEventListener("click", async () => {
    try {
      const data = await api("/api/config", { access_password: $("#accessPassword").value });
      state.config = data.config;
      toast($("#accessPassword").value ? "访问密码已设置并保存" : "访问密码已清除", "success");
      updateShareInfo();
    } catch (e) {
      toast("保存失败：" + e.message, "error");
    }
  });

  $("#copyLanUrl").addEventListener("click", () => {
    const url = (state.shareInfo && state.shareInfo.lan_urls && state.shareInfo.lan_urls[0]) || "";
    if (url) copyText(url, "局域网地址已复制");
    else toast("当前为仅本机模式，请用「分享给局域网.bat」启动", "error");
  });

  $("#savePrefix").addEventListener("click", async () => {
    try {
      const prefix = {};
      $$(".prefix-input").forEach((ta) => { prefix[ta.dataset.prefix] = ta.value; });
      const data = await api("/api/config", { prefix });
      state.config = data.config;
      toast("前缀词已保存", "success");
    } catch (e) {
      toast(e.message, "error");
    }
  });

  function currentPrefix(cat) {
    const ta = document.querySelector(`.prefix-input[data-prefix="${cat}"]`);
    if (ta && ta.value.trim()) return ta.value.trim();
    return (state.config.prefix || {})[cat] || "";
  }

  // ---------------- 第 1 步：剧本 ----------------
  $("#scriptInput").addEventListener("input", (e) => {
    state.script = e.target.value;
    $("#scriptCount").textContent = state.script.length + " 字";
    saveLocal();
  });

  $("#scriptFile").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      $("#scriptInput").value = reader.result;
      state.script = reader.result;
      $("#scriptCount").textContent = state.script.length + " 字";
      saveLocal();
      toast("已载入「" + file.name + "」", "success");
    };
    reader.readAsText(file, "utf-8");
    e.target.value = "";
  });

  const SAMPLE_SCRIPT = `【场景】深夜 · 旧城区天台
【人物】林晓、陈默、神秘人

林晓：这里就是我们小时候的秘密基地吧。
陈默：都十年了，你居然还记得。
林晓：（苦笑）有些事，忘不掉的。
陈默：所以，你查到当年那封信是谁寄的了？
林晓：是那个神秘人。他手里的怀表，是父亲的遗物。
陈默：什么？！怀表不是早就丢了？
林晓：我在他手里看到了。一模一样，连那道裂纹都在。
陈默：那今晚，我们就去拿回来。
林晓：等一下。如果真的是他，我们必须小心，他可能有枪。
（远处传来脚步声，两人同时警觉）
陈默：有人来了。藏好。`;

  $("#loadSample").addEventListener("click", () => {
    $("#scriptInput").value = SAMPLE_SCRIPT;
    state.script = SAMPLE_SCRIPT;
    $("#scriptCount").textContent = state.script.length + " 字";
    saveLocal();
    toast("已载入示例剧本", "success");
  });

  $("#toStep2").addEventListener("click", () => {
    if (!state.script.trim()) { toast("请先输入或上传剧本", "error"); return; }
    goStep(2);
  });

  // ---------------- 第 2 步：风格 ----------------
  $$(".style-card").forEach((card) => {
    card.addEventListener("click", () => {
      state.style = card.dataset.style;
      $$(".style-card").forEach((c) => c.classList.toggle("selected", c === card));
      saveLocal();
    });
  });
  $("#toStep3").addEventListener("click", () => goStep(3));

  // ---------------- 演示模式 ----------------
  $("#demoMode").addEventListener("change", (e) => {
    state.mock = e.target.checked;
    updateProviderBadge();
    saveLocal();
    toast(state.mock ? "已开启演示模式，将使用本地模拟结果" : "已关闭演示模式，将调用真实模型", "success");
  });

  // ---------------- 第 4 步：资产拆分 ----------------
  function normalizeAssets(data) {
    const out = { characters_single: [], characters_group: [], scenes: [], props: [] };
    (data.characters_single || []).forEach((a) => out.characters_single.push(normalizeAsset(a, "character_single")));
    (data.characters_group || []).forEach((a) => out.characters_group.push(normalizeAsset(a, "character_group")));
    (data.scenes || []).forEach((a) => out.scenes.push(normalizeAsset(a, "scene")));
    (data.props || []).forEach((a) => out.props.push(normalizeAsset(a, "prop")));
    out.characters_single = mergeCharacters(out.characters_single);
    out.characters_group = mergeCharacters(out.characters_group);
    return out;
  }

  function mergeCharacters(items) {
    const seen = {};
    const out = [];
    (items || []).forEach((it) => {
      let base = String(it.name || "").replace(/[（(【\[][^）)】\]]*[）)】\]]/g, "").replace(/(OS|内心|旁白|独白|心声)$/i, "").trim();
      if (!base || CHARACTER_IGNORE.indexOf(base) !== -1) return;
      if (seen[base]) {
        const t = seen[base];
        (it.keywords || []).forEach((k) => { if (t.keywords.indexOf(k) === -1) t.keywords.push(k); });
        if (it.script_ref && t.script_ref.indexOf(it.script_ref) === -1) {
          t.script_ref = (t.script_ref ? t.script_ref + "；" : "") + it.script_ref;
        }
        return;
      }
      it.name = base;
      seen[base] = it;
      out.push(it);
    });
    return out;
  }

  function normalizeAsset(a, cat) {
    return {
      uid: a.uid || uid(),
      name: a.name || "未命名",
      category: cat,
      level: a.level || (cat === "character_group" ? "路人NPC/群像" : ""),
      age: a.age || "",
      body: a.body || "",
      face: a.face || "",
      hairstyle: a.hairstyle || "",
      outfit: a.outfit || "",
      temperament: a.temperament || "",
      script_actions: a.script_actions || "",
      features: a.features || "",
      description: a.description || "",
      keywords: Array.isArray(a.keywords) ? a.keywords : [],
      script_ref: a.script_ref || "",
      _ref: a._ref || "",
    };
  }

  function progressUI(kind) {
    return {
      wrap: $("#" + kind + "ProgressWrap"),
      fill: $("#" + kind + "ProgressFill"),
      stage: $("#" + kind + "ProgressStage"),
      pct: $("#" + kind + "ProgressPct"),
    };
  }

  function setProgress(p, percent, stage) {
    if (!p || !p.wrap) return;
    p.wrap.classList.remove("hidden");
    p.fill.style.width = percent + "%";
    p.pct.textContent = Math.round(percent) + "%";
    if (stage) p.stage.textContent = stage;
  }

  function startSimulatedProgress(p, stages) {
    let percent = 5, si = 0;
    setProgress(p, 5, stages[0]);
    const timer = setInterval(() => {
      percent = Math.min(90, percent + Math.random() * 7 + 2);
      if (Math.random() < 0.35 && si < stages.length - 1) si++;
      setProgress(p, Math.floor(percent), stages[si]);
    }, 600);
    return () => clearInterval(timer);
  }

  async function pollTaskProgress(taskId, p) {
    for (;;) {
      await new Promise((r) => setTimeout(r, 700));
      let data;
      try {
        const resp = await fetch("/api/task?task_id=" + encodeURIComponent(taskId));
        data = await resp.json();
      } catch (e) {
        throw new Error("获取任务进度失败");
      }
      if (!data.ok) throw new Error(data.error || "任务失败");
      setProgress(p, data.percent || 0, data.stage || "");
      if (data.status === "done") return data.result;
      if (data.status === "error") throw new Error(data.error || "任务失败");
    }
  }

  async function runAnalyze() {
    const btn = $("#runAnalyze");
    btn.disabled = true;
    $("#analyzeLoading").classList.remove("hidden");
    const hint = $("#analyzeHint");
    hint.classList.remove("error-text");
    hint.textContent = "正在调用 " + (state.mock ? "演示引擎" : currentProviderLabel()) + "…";
    const p = progressUI("analyze");
    let stopSim = null;
    try {
      let assets, count, isMock;
      if (state.mock || DIRECT) {
        if (DIRECT || state.mock) stopSim = startSimulatedProgress(p, ["正在通读剧本…", "正在拆解人物…", "正在拆解场景与道具…", "正在合并去重…"]);
        const data = await api("/api/analyze", {
          script: state.script,
          style: state.style,
          mock: state.mock,
          provider_id: state.activeProvider,
        });
        assets = data.assets;
        count = data.count;
        isMock = data.mock;
      } else {
        const data = await api("/api/analyze", {
          script: state.script,
          style: state.style,
          mock: state.mock,
          provider_id: state.activeProvider,
          progress: true,
        });
        assets = await pollTaskProgress(data.task_id, p);
        count = countAssets(assets);
        isMock = false;
      }
      if (stopSim) { stopSim(); stopSim = null; }
      setProgress(p, 100, "拆分完成");
      state.assets = normalizeAssets(assets);
      state.prompts = {};
      renderAssets();
      $("#assetSection").classList.remove("hidden");
      $("#assetSection").scrollIntoView({ behavior: "smooth" });
      toast("拆分完成，共 " + count + " 项资产" + (isMock ? "（演示）" : ""), "success");
    } catch (e) {
      const msg = friendlyError(e.message);
      toast("拆分失败：" + msg, "error");
      hint.classList.add("error-text");
      hint.textContent = "✘ 拆分失败：" + msg;
    } finally {
      btn.disabled = false;
      $("#analyzeLoading").classList.add("hidden");
      if (stopSim) stopSim();
      setTimeout(() => p.wrap.classList.add("hidden"), 1500);
      saveLocal();
    }
  }
  $("#runAnalyze").addEventListener("click", runAnalyze);

  function renderAssets() {
    syncAssetView();
    $$(".asset-tabs .tab").forEach((t) => {
      const key = ASSET_CATEGORY[t.dataset.tab];
      $("#count-" + t.dataset.tab).textContent = state.assets[key].length;
      t.classList.toggle("active", state.activeTab === t.dataset.tab);
    });
    const list = $("#assetList");
    list.innerHTML = "";
    const key = ASSET_CATEGORY[state.activeTab];
    const filtered = state.assets[key].filter(matchesSearch);
    filtered.forEach((asset, i) => {
      list.appendChild(buildAssetCard(asset, i));
    });
    if (!filtered.length) {
      const empty = document.createElement("div");
      empty.className = "card empty-hint";
      empty.textContent = state.assetSearch ? "未找到匹配的资产，试试其它关键词" : "该分类暂无资产";
      list.appendChild(empty);
    }
    const epMode = state.assetView === "episodes";
    $("#assetSearch").classList.toggle("hidden", epMode);
    $("#epViewSelect").classList.toggle("hidden", !epMode);
    $("#fillAllEpisodes").classList.toggle("hidden", !epMode);
    if (epMode) {
      const sel = $("#epViewSelect");
      const eps = detectEpisodesLocal();
      sel.innerHTML = '<option value="__all__">全部集数</option>';
      eps.forEach((e) => {
        const opt = document.createElement("option");
        opt.value = e.name;
        opt.textContent = e.name + "（" + e.script.length + " 字）";
        sel.appendChild(opt);
      });
      if (state.epViewFilter !== "__all__" && eps.some((e) => e.name === state.epViewFilter)) {
        sel.value = state.epViewFilter;
      } else {
        state.epViewFilter = "__all__";
        sel.value = "__all__";
      }
    }
    list.classList.toggle("hidden", epMode);
    $$(".asset-tabs").forEach((t) => t.classList.toggle("hidden", epMode));
    $$(".add-asset-bar").forEach((t) => t.classList.toggle("hidden", epMode));
    $("#episodeAssetView").classList.toggle("hidden", !epMode);
    if (epMode) renderEpisodeAssetView();
    saveLocal();
  }

  function matchesSearch(asset) {
    const q = state.assetSearch.trim().toLowerCase();
    if (!q) return true;
    const hay = ((asset.name || "") + " " + (asset.description || "") + " " + (asset.keywords || []).join(" ") + " " + (asset.script_ref || "")).toLowerCase();
    return hay.indexOf(q) !== -1;
  }

  function inEpisode(a, seg) {
    const t = seg || "";
    if (a.name && t.indexOf(a.name) !== -1) return true;
    return (a.keywords || []).some((k) => k && t.indexOf(k) !== -1);
  }

  function computeEpisodeMissing(seg, allAssets) {
    const speakers = Array.from(new Set(parseDialogues(seg).map((d) => d.name)));
    const haveNames = new Set(allAssets.filter((a) => a.category === "character_single").map((a) => a.name));
    const missingChars = speakers.filter((n) => !haveNames.has(n) && !allAssets.some((a) => a.name === n));
    const hdrs = sceneHeaders(seg);
    const sceneNames = new Set(allAssets.filter((a) => a.category === "scene" && inEpisode(a, seg)).map((a) => a.name));
    const missingScenes = Array.from(new Set(hdrs.filter((h) => !sceneNames.has(h.name)).map((h) => h.name)));
    const propNames = new Set(allAssets.filter((a) => a.category === "prop" && inEpisode(a, seg)).map((a) => a.name));
    const missingProps = [];
    P.propKeywords.forEach((k) => {
      if (seg.indexOf(k) !== -1 && !propNames.has(k) && missingProps.indexOf(k) === -1) missingProps.push(k);
    });
    return { missingChars, missingScenes, missingProps, hdrs };
  }

  function renderEpisodeAssetView() {
    const wrap = $("#episodeAssetView");
    wrap.innerHTML = "";
    const eps = splitEpisodes(state.script);
    const allAssets = flattenAssets();
    if (!eps.length) {
      wrap.innerHTML = '<div class="card"><div class="panel-sub">剧本中未检测到「第X集」标记，无法按集查看。请在每集开头写【第1集】【第2集】…</div></div>';
      return;
    }
    // 缺失角色只在其「首次出现」的集数提示，避免每集重复
    const firstOccur = {};
    eps.forEach((e) => {
      Array.from(new Set(parseDialogues(e.script).map((d) => d.name))).forEach((n) => {
        if (!(n in firstOccur)) firstOccur[n] = e.name;
      });
    });
    const q = state.assetSearch.trim();
    const shown = eps.filter((e) => state.epViewFilter === "__all__" || e.name === state.epViewFilter);
    shown.forEach((e) => {
      const seg = e.script;
      const card = document.createElement("div");
      card.className = "ep-asset-card";
      const title = document.createElement("div");
      title.className = "ep-asset-title";
      title.textContent = e.name;
      const addBtn = mkMiniBtn("＋ 添加该集资产", () => openAddModal(null, e.name));
      title.appendChild(addBtn);
      card.appendChild(title);
      const det = document.createElement("details");
      det.className = "ep-script";
      const sum = document.createElement("summary");
      sum.textContent = "查看本集剧本原文（" + seg.length + " 字）";
      const pre = document.createElement("pre");
      pre.textContent = seg;
      det.append(sum, pre);
      card.appendChild(det);
      const chars = allAssets.filter((a) => (a.category === "character_single" || a.category === "character_group") && inEpisode(a, seg) && (!q || matchesSearch(a)));
      const scenes = allAssets.filter((a) => a.category === "scene" && inEpisode(a, seg) && (!q || matchesSearch(a)));
      const props = allAssets.filter((a) => a.category === "prop" && inEpisode(a, seg) && (!q || matchesSearch(a)));
      const { missingChars, missingScenes, missingProps, hdrs } = computeEpisodeMissing(seg, allAssets);
      const missing = missingChars.filter((n) => firstOccur[n] === e.name);
      card.appendChild(chipRow("人物", chars.map((a) => a.name)));
      card.appendChild(chipRow("群像", chars.filter((a) => a.category === "character_group").map((a) => a.name)));
      card.appendChild(chipRow("场景", scenes.map((a) => a.name)));
      card.appendChild(chipRow("道具", props.map((a) => a.name)));
      // 场景编号核对（1-1日 外 镇北王府）
      if (hdrs.length) {
        const hrow = document.createElement("div");
        hrow.className = "ep-row";
        const hlab = document.createElement("span");
        hlab.className = "ep-row-label";
        hlab.textContent = "场景编号";
        hrow.appendChild(hlab);
        hdrs.forEach((h) => {
          const chip = document.createElement("span");
          chip.className = "ep-chip";
          chip.textContent = h.no + "·" + h.name;
          hrow.appendChild(chip);
        });
        card.appendChild(hrow);
        if (missingScenes.length) {
          const miss = document.createElement("div");
          miss.className = "ep-missing";
          miss.style.borderColor = "rgba(56,217,169,0.35)";
          miss.style.color = "var(--cyan)";
          const label = document.createElement("span");
          label.textContent = "⚠ 该集有编号但未拆分的场景：" + missingScenes.join("、") + " ";
          const btn = mkMiniBtn("一键补全", () => {
            missingScenes.forEach((n) => addMissingScene(n, e.name));
            renderEpisodeAssetView();
            renderAssets();
            toast("已补全 " + missingScenes.length + " 个场景", "success");
          });
          miss.append(label, btn);
          card.appendChild(miss);
        }
      }
      // 道具核对（按关键词扫描）
      if (missingProps.length) {
        const miss = document.createElement("div");
        miss.className = "ep-missing";
        const label = document.createElement("span");
        label.textContent = "⚠ 该集疑似出现的道具未拆分：" + missingProps.join("、") + " ";
        const btn = mkMiniBtn("一键补全", () => {
          missingProps.forEach((k) => addMissingProp(k, e.name));
          renderEpisodeAssetView();
          renderAssets();
          toast("已补全 " + missingProps.length + " 个道具", "success");
        });
        miss.append(label, btn);
        card.appendChild(miss);
      }
      if (missing.length) {
        const miss = document.createElement("div");
        miss.className = "ep-missing";
        const label = document.createElement("span");
        label.textContent = "⚠ 该集有台词但未拆分的角色：" + missing.join("、") + " ";
        const btn = mkMiniBtn("一键补全", () => {
          missing.forEach((n) => addMissingCharacter(n, e.name));
          renderEpisodeAssetView();
          renderAssets();
          toast("已补全 " + missing.length + " 个角色", "success");
        });
        miss.append(label, btn);
        card.appendChild(miss);
      }
      wrap.appendChild(card);
      if (state.epViewFilter !== "__all__" && e.name === state.epViewFilter) {
        setTimeout(() => card.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
      }
    });
    const notFound = allAssets.filter((a) => !eps.some((e) => inEpisode(a, e.script)));
    if (state.epViewFilter === "__all__" && notFound.length) {
      const card = document.createElement("div");
      card.className = "ep-asset-card";
      const title = document.createElement("div");
      title.className = "ep-asset-title";
      title.textContent = "未定位到集数的资产（手动添加或全局资产）";
      card.appendChild(title);
      card.appendChild(chipRow("资产", notFound.map((a) => a.name)));
      wrap.appendChild(card);
    }
  }

  function chipRow(label, names) {
    const row = document.createElement("div");
    row.className = "ep-row";
    const lab = document.createElement("span");
    lab.className = "ep-row-label";
    lab.textContent = label;
    row.appendChild(lab);
    if (!names.length) {
      const none = document.createElement("span");
      none.className = "ep-chip none";
      none.textContent = "无";
      row.appendChild(none);
    } else {
      names.forEach((n) => {
        const chip = document.createElement("span");
        chip.className = "ep-chip";
        chip.textContent = n;
        row.appendChild(chip);
      });
    }
    return row;
  }

  function addMissingCharacter(name, episode) {
    const exists = state.assets.characters_single.some((a) => a.name === name);
    if (exists) return false;
    state.assets.characters_single.push(normalizeAsset({
      name,
      category: "character_single",
      level: "次要配角",
      description: "依据" + episode + "剧本补充的角色：" + name + "，仅描述人物本身（外貌、体型、发型、穿搭、气质），不含任何场景与道具。",
      keywords: [name, "人物"],
      script_ref: episode + "中有台词",
    }, "character_single"));
    return true;
  }

  function addMissingScene(name, episode) {
    const exists = state.assets.scenes.some((a) => a.name === name);
    if (exists) return false;
    state.assets.scenes.push(normalizeAsset({
      name,
      category: "scene",
      description: "依据" + episode + "场次编号补充的场景：「" + name + "」，按剧本氛围呈现空间结构、环境、光线与天气，画面干净无人物。",
      keywords: [name],
      script_ref: episode + "场次编号",
    }, "scene"));
    return true;
  }

  function addMissingProp(name, episode) {
    const exists = state.assets.props.some((a) => a.name === name);
    if (exists) return false;
    state.assets.props.push(normalizeAsset({
      name,
      category: "prop",
      description: "依据" + episode + "剧本补充的道具：「" + name + "」，按剧本呈现材质、颜色、尺寸、造型与新旧状态，纯物品无人物无场景。",
      keywords: [name],
      script_ref: episode + "中出现",
    }, "prop"));
    return true;
  }


  function buildAssetCard(asset, idx) {
    const card = document.createElement("div");
    card.className = "asset-card";
    card.dataset.uid = asset.uid;
    card.style.animationDelay = Math.min(idx * 40, 400) + "ms";

    const head = document.createElement("div");
    head.className = "asset-head";
    const name = document.createElement("div");
    name.className = "asset-name";
    name.textContent = asset.name;
    const tag = document.createElement("span");
    tag.className = "asset-tag " + asset.category;
    tag.textContent = CATEGORY_LABEL[ASSET_CATEGORY[asset.category]];
    head.append(name, tag);
    if (asset.level) {
      const lv = document.createElement("span");
      lv.className = "asset-level";
      lv.textContent = asset.level;
      head.appendChild(lv);
    }
    const actions = document.createElement("div");
    actions.className = "asset-actions";
    actions.append(
      mkMiniBtn("复制描述", () => copyText(asset.description, "描述已复制")),
      mkMiniBtn("删除", () => deleteAsset(asset), "danger")
    );
    head.appendChild(actions);

    const body = document.createElement("div");
    body.className = "asset-body";
    const descTa = mkField("视觉描述（用于生成提示词）", "textarea", asset.description);
    descTa.addEventListener("input", (e) => { asset.description = e.target.value; saveLocal(); });
    descTa.classList.add("full");
    const kwIn = mkField("隔离关键词（逗号分隔）", "input", asset.keywords.join(","));
    kwIn.addEventListener("input", (e) => {
      asset.keywords = e.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
      saveLocal();
    });
    const refIn = mkField("参考词（该资产专用）", "input", asset._ref || "");
    refIn.addEventListener("input", (e) => { asset._ref = e.target.value; saveLocal(); });
    const srcIn = mkField("剧本依据", "input", asset.script_ref);
    srcIn.addEventListener("input", (e) => { asset.script_ref = e.target.value; saveLocal(); });
    body.append(descTa, kwIn, refIn, srcIn);

    if (asset.category === "character_single") {
      body.appendChild(buildCharacterDetail(asset));
    }

    card.append(head, body);
    return card;
  }

  function buildCharacterDetail(asset) {
    const det = document.createElement("details");
    det.className = "asset-detail";
    const sum = document.createElement("summary");
    sum.textContent = "人设细节（年龄/体态/脸型/发型/穿搭/气质/剧本动作/专属特征）";
    det.appendChild(sum);
    const grid = document.createElement("div");
    grid.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:8px 12px;width:100%;margin-top:10px;";
    const fields = [
      ["age", "年龄"], ["body", "身高体态"], ["face", "脸型五官"], ["hairstyle", "发型发色"],
      ["outfit", "穿搭全套"], ["temperament", "气质人设"], ["script_actions", "剧本动作（只取原文）"], ["features", "专属特征"],
    ];
    fields.forEach(([key, label]) => {
      const lab = document.createElement("label");
      lab.style.cssText = "display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--text-dim);";
      const span = document.createElement("span");
      span.textContent = label;
      const inp = document.createElement("input");
      inp.value = asset[key] || "";
      inp.addEventListener("input", (e) => { asset[key] = e.target.value; saveLocal(); });
      lab.append(span, inp);
      grid.appendChild(lab);
    });
    det.appendChild(grid);
    return det;
  }

  function mkField(label, type, value) {
    const wrap = document.createElement("label");
    wrap.className = "field";
    const span = document.createElement("span");
    span.textContent = label;
    const el = document.createElement(type);
    if (type === "textarea") el.rows = 3;
    el.value = value || "";
    wrap.append(span, el);
    return el;
  }

  function mkMiniBtn(text, fn, cls = "") {
    const b = document.createElement("button");
    b.className = "mini-btn" + (cls ? " " + cls : "");
    b.textContent = text;
    b.addEventListener("click", fn);
    return b;
  }

  function deleteAsset(asset) {
    const key = ASSET_CATEGORY[asset.category];
    state.assets[key] = state.assets[key].filter((a) => a.uid !== asset.uid);
    delete state.prompts[asset.uid];
    renderAssets();
    renderPromptAssetList();
    toast("已删除资产「" + asset.name + "」");
  }

  $$(".asset-tabs .tab").forEach((t) => {
    t.addEventListener("click", () => {
      state.activeTab = t.dataset.tab;
      renderAssets();
    });
  });

  $("#assetSearch").addEventListener("input", (e) => {
    state.assetSearch = e.target.value;
    renderAssets();
  });
  function syncAssetView() {
    $("#viewAllAssets").classList.toggle("active", state.assetView === "all");
    $("#viewByEpisodes").classList.toggle("active", state.assetView === "episodes");
  }
  $("#viewAllAssets").addEventListener("click", () => {
    state.assetView = "all";
    syncAssetView();
    renderAssets();
  });
  $("#viewByEpisodes").addEventListener("click", () => {
    state.assetView = "episodes";
    syncAssetView();
    renderAssets();
  });
  $("#epViewSelect").addEventListener("change", (e) => {
    state.epViewFilter = e.target.value;
    renderEpisodeAssetView();
  });
  $("#fillAllEpisodes").addEventListener("click", () => {
    const eps = splitEpisodes(state.script);
    if (!eps.length) { toast("剧本中未检测到集数标记", "error"); return; }
    let chars = 0, scenes = 0, props = 0;
    eps.forEach((e) => {
      const m = computeEpisodeMissing(e.script, flattenAssets());
      m.missingChars.forEach((n) => { if (addMissingCharacter(n, e.name)) chars++; });
      m.missingScenes.forEach((n) => { if (addMissingScene(n, e.name)) scenes++; });
      m.missingProps.forEach((n) => { if (addMissingProp(n, e.name)) props++; });
    });
    renderEpisodeAssetView();
    renderAssets();
    toast("已补全：人物 " + chars + " 个，场景 " + scenes + " 个，道具 " + props + " 个", "success");
  });

  $("#addAssetBtn").addEventListener("click", () => openAddModal());
  let pendingAddEpisode = "";
  function openAddModal(prefill, episode) {
    pendingAddEpisode = episode || "";
    $("#addAssetModal").classList.remove("hidden");
    $("#newAssetName").value = prefill && prefill.name ? prefill.name : "";
    $("#newAssetDesc").value = prefill && prefill.description_hint ? prefill.description_hint : "";
    $("#newAssetKeywords").value = "";
    if (prefill) {
      $("#newAssetCategory").value = ASSET_CATEGORY[prefill.category] || "character_single";
    }
  }
  $("#closeAddAsset").addEventListener("click", () => $("#addAssetModal").classList.add("hidden"));
  $("#cancelAddAsset").addEventListener("click", () => $("#addAssetModal").classList.add("hidden"));

  $("#confirmAddAsset").addEventListener("click", () => {
    const catKey = $("#newAssetCategory").value;
    const name = $("#newAssetName").value.trim();
    const desc = $("#newAssetDesc").value.trim();
    const kws = $("#newAssetKeywords").value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    if (!name) { toast("请填写资产名称", "error"); return; }
    const asset = normalizeAsset({
      name,
      category: catKey,
      description: desc || "手动添加资产：" + name,
      keywords: kws,
      script_ref: pendingAddEpisode ? "手动添加（" + pendingAddEpisode + "）" : "手动添加",
    }, catKey === "character_single" ? "character_single" : catKey === "character_group" ? "character_group" : catKey === "scene" ? "scene" : "prop");
    state.assets[catKey].push(asset);
    renderAssets();
    renderPromptAssetList();
    $("#addAssetModal").classList.add("hidden");
    toast("已添加资产「" + name + "」", "success");
    saveLocal();
  });

  $("#toStep4").addEventListener("click", () => goStep(4));
  $("#toStep5").addEventListener("click", () => {
    if (flattenAssets().length === 0) { toast("请先完成资产拆分", "error"); return; }
    renderPromptAssetList();
    goStep(5);
  });

  // ---------------- 第 5 步：提示词生成 ----------------
  function renderPromptAssetList() {
    const list = $("#promptAssetList");
    list.innerHTML = "";
    const all = flattenAssets();
    const q = state.promptSearch.trim().toLowerCase();
    const filtered = all.filter((a) => {
      if (state.promptCat !== "all" && a.category !== state.promptCat) return false;
      if (!q) return true;
      const hay = ((a.name || "") + " " + (a.description || "") + " " + (a.keywords || []).join(" ") + " " + (a.script_ref || "")).toLowerCase();
      return hay.indexOf(q) !== -1;
    });
    // 分类标签数量
    $$("#promptCatTabs .btn").forEach((b) => {
      const cat = b.dataset.pcat;
      const count = cat === "all" ? all.length : all.filter((a) => a.category === cat).length;
      b.textContent = b.dataset.label + " (" + count + ")";
      b.classList.toggle("active", state.promptCat === cat);
    });
    filtered.forEach((asset) => list.appendChild(buildPromptBlock(asset)));
    if (!filtered.length) {
      const empty = document.createElement("div");
      empty.className = "card empty-hint";
      empty.textContent = state.promptSearch ? "未找到匹配的资产，试试其它关键词" : "该分类暂无资产";
      list.appendChild(empty);
    }
  }

  $("#promptSearch").addEventListener("input", (e) => {
    state.promptSearch = e.target.value;
    renderPromptAssetList();
  });
  $$("#promptCatTabs .btn").forEach((b) => {
    b.addEventListener("click", () => {
      state.promptCat = b.dataset.pcat;
      renderPromptAssetList();
    });
  });

  function buildPromptBlock(asset) {
    const block = document.createElement("div");
    block.className = "prompt-block";
    block.dataset.uid = asset.uid;

    const head = document.createElement("div");
    head.className = "prompt-block-head";
    const name = document.createElement("span");
    name.className = "asset-name";
    name.textContent = asset.name;
    const tag = document.createElement("span");
    tag.className = "asset-tag " + asset.category;
    tag.textContent = CATEGORY_LABEL[ASSET_CATEGORY[asset.category]];
    const genBtn = document.createElement("button");
    genBtn.className = "btn";
    genBtn.textContent = "生成";
    genBtn.addEventListener("click", () => generateOne(asset, genBtn));
    head.append(name, tag, genBtn);

    const refRow = document.createElement("div");
    refRow.className = "prompt-foot";
    const refInput = document.createElement("input");
    refInput.className = "ref-input";
    refInput.placeholder = "该资产的参考词（风格 / 细节 / 参考角色等）";
    refInput.value = asset._ref || "";
    refInput.addEventListener("input", (e) => { asset._ref = e.target.value; saveLocal(); });
    refRow.appendChild(refInput);

    const items = document.createElement("div");
    items.className = "prompt-items";
    block.append(head, refRow, items);

    const saved = state.prompts[asset.uid];
    if (saved) renderPromptItems(items, asset, saved, genBtn);
    return block;
  }

  function renderPromptItems(items, asset, data, genBtn) {
    items.innerHTML = "";
    const clean = data.isolation && data.isolation.clean;
    const warnings = (data.isolation && data.isolation.warnings) || [];
    const badge = document.createElement("div");
    badge.className = "badge " + (clean ? "clean" : "error");
    badge.textContent = clean
      ? "✔ 隔离校验通过（无交叉污染）"
      : "✘ 检测到交叉污染：" + warnings.map((w) => "「" + w.word + "」").join("、");
    items.appendChild(badge);

    (data.prompts || []).forEach((p) => {
      const item = document.createElement("div");
      item.className = "prompt-item";
      const text = document.createElement("div");
      text.className = "text";
      text.textContent = p.text || "";
      const foot = document.createElement("div");
      foot.className = "prompt-foot";
      const note = document.createElement("span");
      note.className = "note";
      note.textContent = p.note || "";
      const copy = mkMiniBtn("复制", () => copyText(p.text, "提示词已复制"));
      foot.append(note, copy);
      item.append(text, foot);
      items.appendChild(item);
    });
    if (genBtn) genBtn.textContent = "重新生成";
  }

  async function generateOne(asset, btn) {
    const original = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = "生成中…"; }
    try {
      const data = await api("/api/generate_prompt", {
        asset: {
          name: asset.name,
          category: asset.category,
          description: asset.description,
          keywords: asset.keywords,
        },
        style: state.style,
        mock: state.mock,
        provider_id: state.activeProvider,
        prefix: currentPrefix(asset.category),
        reference_words: asset._ref || "",
        assets: flattenAssets(),
      });
      state.prompts[asset.uid] = data;
      const block = document.querySelector(`.prompt-block[data-uid="${asset.uid}"]`);
      if (block) {
        const items = block.querySelector(".prompt-items");
        const genBtn = block.querySelector(".prompt-block-head .btn");
        renderPromptItems(items, asset, data, genBtn);
      }
      saveLocal();
      return data;
    } catch (e) {
      toast("生成失败（" + asset.name + "）：" + friendlyError(e.message), "error");
      throw e;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = original; }
    }
  }

  async function generateAll() {
    const assets = flattenAssets();
    if (assets.length === 0) { toast("请先完成资产拆分", "error"); return; }
    const btn = $("#generateAll");
    btn.disabled = true;
    $("#promptLoading").classList.remove("hidden");
    let done = 0;
    try {
      const limit = 3;
      let i = 0;
      const worker = async () => {
        while (i < assets.length) {
          const idx = i++;
          try {
            await generateOne(assets[idx], null);
          } catch (e) { /* 已提示 */ }
          done++;
          $("#promptLoading span").textContent = "正在逐资产生成提示词… " + done + " / " + assets.length;
        }
      };
      await Promise.all(Array.from({ length: Math.min(limit, assets.length) }, () => worker()));
      toast("全部提示词生成完成", "success");
    } finally {
      btn.disabled = false;
      $("#promptLoading").classList.add("hidden");
      saveLocal();
    }
  }
  $("#generateAll").addEventListener("click", generateAll);
  $("#toStep6").addEventListener("click", () => {
    renderVerifyResult();
    goStep(6);
  });

  // ---------------- 第 6 步：校验与补全 ----------------
  async function runVerify() {
    const assets = flattenAssets();
    if (assets.length === 0) { toast("请先完成资产拆分", "error"); return; }
    const btn = $("#runVerify");
    btn.disabled = true;
    $("#verifyLoading").classList.remove("hidden");
    const p = progressUI("verify");
    let stopSim = null;
    try {
      let report, isMock;
      if (state.mock || DIRECT) {
        if (DIRECT || state.mock) stopSim = startSimulatedProgress(p, ["正在核对人物与群像…", "正在核对场景与道具…", "正在生成校验报告…"]);
        const data = await api("/api/verify", {
          script: state.script,
          assets,
          style: state.style,
          mock: state.mock,
          provider_id: state.activeProvider,
        });
        report = data.report;
        isMock = data.mock;
      } else {
        const data = await api("/api/verify", {
          script: state.script,
          assets,
          style: state.style,
          mock: state.mock,
          provider_id: state.activeProvider,
          progress: true,
        });
        report = await pollTaskProgress(data.task_id, p);
        isMock = false;
      }
      if (stopSim) { stopSim(); stopSim = null; }
      setProgress(p, 100, "校验完成");
      state.verifyReport = report;
      renderVerifyResult();
      $("#verifyResult").classList.remove("hidden");
      $("#verifyResult").scrollIntoView({ behavior: "smooth" });
      toast("校验完成" + (isMock ? "（演示）" : ""), "success");
    } catch (e) {
      toast("校验失败：" + friendlyError(e.message), "error");
    } finally {
      btn.disabled = false;
      $("#verifyLoading").classList.add("hidden");
      if (stopSim) stopSim();
      setTimeout(() => p.wrap.classList.add("hidden"), 1500);
      saveLocal();
    }
  }
  $("#runVerify").addEventListener("click", runVerify);

  function renderVerifyResult() {
    const wrap = $("#verifyResult");
    if (!state.verifyReport) { wrap.classList.add("hidden"); return; }
    wrap.classList.remove("hidden");
    wrap.innerHTML = "";
    const r = state.verifyReport;
    const summary = document.createElement("div");
    summary.className = "verify-summary";
    summary.textContent = "📋 " + (r.summary || "校验完成");
    wrap.appendChild(summary);

    const issues = r.issues || [];
    if (issues.length) {
      const title = document.createElement("div");
      title.className = "panel-sub";
      title.textContent = "发现 " + issues.length + " 个问题";
      wrap.appendChild(title);
      const list = document.createElement("div");
      list.className = "issue-list";
      issues.forEach((it) => {
        const item = document.createElement("div");
        item.className = "issue-item " + (it.level || "low");
        const d = document.createElement("div");
        d.className = "detail";
        d.textContent = typeLabel(it.type) + "：" + (it.detail || "");
        const s = document.createElement("div");
        s.className = "suggestion";
        s.textContent = "建议：" + (it.suggestion || "");
        item.append(d, s);
        list.appendChild(item);
      });
      wrap.appendChild(list);
    } else {
      const ok = document.createElement("div");
      ok.className = "verify-summary";
      ok.style.borderColor = "rgba(56,217,169,0.4)";
      ok.textContent = "✔ 未发现问题";
      wrap.appendChild(ok);
    }

    const missing = r.missing_suggestions || [];
    if (missing.length) {
      const title = document.createElement("div");
      title.className = "panel-sub";
      title.textContent = "建议补充 " + missing.length + " 项资产";
      wrap.appendChild(title);
      const allBtn = document.createElement("button");
      allBtn.className = "btn primary";
      allBtn.textContent = "✔ 一键全部添加（" + missing.length + " 项）";
      allBtn.addEventListener("click", () => {
        let added = 0;
        missing.forEach((m) => { if (applyMissing(m, true)) added++; });
        renderVerifyResult();
        toast("已补充 " + added + " 项资产（重复项已跳过）", "success");
      });
      wrap.appendChild(allBtn);
      const list = document.createElement("div");
      list.className = "missing-list";
      missing.forEach((m) => {
        const item = document.createElement("div");
        item.className = "missing-item";
        const name = document.createElement("span");
        name.className = "name";
        name.textContent = m.name || "未命名";
        const reason = document.createElement("span");
        reason.className = "reason";
        reason.textContent = (m.reason || "") + (m.description_hint ? "｜" + m.description_hint : "");
        const apply = mkMiniBtn("应用建议", () => applyMissing(m));
        item.append(name, reason, apply);
        list.appendChild(item);
      });
      wrap.appendChild(list);
    }
  }

  function typeLabel(t) {
    return {
      missing: "缺失资产",
      cross_contamination: "交叉污染",
      unreasonable: "拆分不合理",
      mismatch: "背景不符",
    }[t] || "其他问题";
  }

  function applyMissing(m, silent) {
    const catKey = ASSET_CATEGORY[m.category];
    if (!catKey) { if (!silent) toast("类型不正确", "error"); return false; }
    const exist = state.assets[catKey].some((a) => a.name === m.name);
    if (exist) return false;
    const asset = normalizeAsset({
      name: m.name || "新增资产",
      category: m.category,
      description: m.description_hint || "依据剧本补充的资产",
      keywords: [m.name || ""],
      script_ref: m.reason || "校验建议补充",
    }, m.category);
    state.assets[catKey].push(asset);
    renderAssets();
    renderPromptAssetList();
    if (!silent) toast("已补充资产「" + asset.name + "」", "success");
    saveLocal();
    return true;
  }

  // ---------------- 第 7 步：分镜生成（按集数 + 组浏览） ----------------
  function splitGroups(text) {
    const re = /第\s*\d+\s*组[\s\S]*?(?=第\s*\d+\s*组|$)/g;
    const blocks = (text.match(re) || []).map((s) => s.trim()).filter(Boolean);
    // 修复模型输出：某组缺镜头/总时长（如镜头被误写到下一组）时，与下一组合并
    const merged = [];
    for (let i = 0; i < blocks.length; i++) {
      let cur = blocks[i];
      const complete = () => /镜头\s*\d/.test(cur) && /总时长/.test(cur);
      while (!complete() && i + 1 < blocks.length) {
        const nxt = blocks[++i].replace(/^第\s*\d+\s*组\s*\n?/, "");
        cur = cur + "\n" + nxt;
      }
      merged.push(cur);
    }
    // 按最终顺序重新编号组标题
    return merged.map((g, idx) => g.replace(/^第\s*\d+\s*组/, "第" + (idx + 1) + "组").trim());
  }

  async function runStoryboard() {
    const epName = $("#episodeSelectMain").value || "第1集";
    const btn = $("#runStoryboard");
    btn.disabled = true;
    $("#storyboardLoading").classList.remove("hidden");
    try {
      const data = await api("/api/storyboard", {
        script: state.script,
        style: state.style,
        mock: state.mock,
        provider_id: state.activeProvider,
        episode: epName,
      });
      (data.episodes || []).forEach((ep) => {
        const groups = splitGroups(ep.text);
        state.storyboards[ep.name] = {
          text: groups.join("\n\n"),
          groups,
          mock: data.mock,
          time: Date.now(),
        };
      });
      state.currentEpisode = epName;
      state.currentGroupIdx = -1;
      renderStoryboardBrowser();
      renderStoryboard();
      $("#storyboardResult").classList.remove("hidden");
      $("#storyboardResult").scrollIntoView({ behavior: "smooth" });
      toast("「" + epName + "」分镜生成完成" + (data.mock ? "（演示）" : ""), "success");
    } catch (e) {
      toast("分镜生成失败：" + friendlyError(e.message), "error");
    } finally {
      btn.disabled = false;
      $("#storyboardLoading").classList.add("hidden");
      saveLocal();
    }
  }
  $("#runStoryboard").addEventListener("click", runStoryboard);

  async function runAllStoryboard() {
    const btn = $("#runAllStoryboard");
    btn.disabled = true;
    $("#storyboardLoading").classList.remove("hidden");
    try {
      const data = await api("/api/storyboard", {
        script: state.script,
        style: state.style,
        mock: state.mock,
        provider_id: state.activeProvider,
      });
      state.storyboards = {};
      (data.episodes || []).forEach((ep) => {
        const groups = splitGroups(ep.text);
        state.storyboards[ep.name] = {
          text: groups.join("\n\n"),
          groups,
          mock: data.mock,
          time: Date.now(),
        };
      });
      const names = Object.keys(state.storyboards);
      state.currentEpisode = names[0] || "第1集";
      state.currentGroupIdx = -1;
      renderEpisodeSelectLocal();
      renderStoryboardBrowser();
      renderStoryboard();
      $("#storyboardResult").classList.remove("hidden");
      toast("全部 " + names.length + " 集分镜生成完成" + (data.mock ? "（演示）" : ""), "success");
    } catch (e) {
      toast("分镜生成失败：" + friendlyError(e.message), "error");
    } finally {
      btn.disabled = false;
      $("#storyboardLoading").classList.add("hidden");
      saveLocal();
    }
  }
  $("#runAllStoryboard").addEventListener("click", runAllStoryboard);

  $("#genSelected").addEventListener("click", async () => {
    const names = Object.keys(state.selectedEpisodes).filter((k) => state.selectedEpisodes[k]);
    if (!names.length) { toast("请先勾选要生成的集数", "error"); return; }
    const btn = $("#genSelected");
    btn.disabled = true;
    $("#storyboardLoading").classList.remove("hidden");
    const loadingSpan = $("#storyboardLoading span");
    loadingSpan.textContent = "正在生成选中的 " + names.length + " 集…";
    try {
      const data = await api("/api/storyboard", {
        script: state.script,
        style: state.style,
        mock: state.mock,
        provider_id: state.activeProvider,
        episodes: names,
      });
      (data.episodes || []).forEach((ep) => {
        const groups = splitGroups(ep.text);
        state.storyboards[ep.name] = {
          text: groups.join("\n\n"),
          groups,
          mock: data.mock,
          time: Date.now(),
        };
      });
      state.currentEpisode = (data.episodes && data.episodes[0] && data.episodes[0].name) || names[0];
      state.currentGroupIdx = -1;
      renderEpisodeSelectLocal();
      renderStoryboardBrowser();
      renderStoryboard();
      $("#storyboardResult").classList.remove("hidden");
      toast("已生成：" + (data.episodes || []).map((e) => e.name).join("、"), "success");
    } catch (e) {
      toast("分镜生成失败：" + friendlyError(e.message), "error");
    } finally {
      btn.disabled = false;
      $("#storyboardLoading").classList.add("hidden");
      loadingSpan.textContent = "正在按规则拆镜、绑定台词、校验时长…";
      saveLocal();
    }
  });

  function detectEpisodesLocal() {
    const eps = splitEpisodes(state.script);
    if (!eps.length) return [{ name: state.currentEpisode || "第1集", script: state.script }];
    return eps;
  }

  function renderEpisodeSelectLocal() {
    const sel = $("#episodeSelectMain");
    if (!sel) return;
    const eps = detectEpisodesLocal();
    const current = eps.some((e) => e.name === state.currentEpisode) ? state.currentEpisode : eps[0].name;
    sel.innerHTML = "";
    eps.forEach((e) => {
      const opt = document.createElement("option");
      opt.value = e.name;
      const sb = state.storyboards[e.name];
      opt.textContent = sb ? e.name + "（已生成 " + sb.groups.length + " 组）" : e.name + "（未生成）";
      sel.appendChild(opt);
    });
    sel.value = current;
    state.currentEpisode = current;
    // 多选生成列表
    const checkWrap = $("#epCheckList");
    if (checkWrap) {
      checkWrap.innerHTML = "";
      eps.forEach((e) => {
        const sb = state.storyboards[e.name];
        const chip = document.createElement("div");
        chip.className = "ep-check" + (state.selectedEpisodes[e.name] ? " selected" : "");
        chip.innerHTML = '<span class="mark">✓</span><span>' + e.name + '</span><span class="st">' + (sb ? "已生成 " + sb.groups.length + " 组" : "未生成") + "</span>";
        chip.addEventListener("click", () => {
          state.selectedEpisodes[e.name] = !state.selectedEpisodes[e.name];
          chip.classList.toggle("selected", !!state.selectedEpisodes[e.name]);
          updateEpSelectHint();
        });
        checkWrap.appendChild(chip);
      });
      updateEpSelectHint();
    }
  }

  function updateEpSelectHint() {
    const n = Object.keys(state.selectedEpisodes).filter((k) => state.selectedEpisodes[k]).length;
    $("#epSelectHint").textContent = n > 0
      ? "已勾选 " + n + " 集，点「生成选中的集数」"
      : "勾选一个或多个集数后点生成；也可以直接用上面「生成当前集分镜」或「生成全部集数」";
  }

  $("#detectEpisodes").addEventListener("click", () => {
    const eps = detectEpisodesLocal();
    renderEpisodeSelectLocal();
    toast("已识别 " + eps.length + " 集：" + eps.map((e) => e.name).join("、") + "（选择后点击「生成当前集分镜」）", "success");
  });

  function renderStoryboardBrowser() {
    renderEpisodeSelectLocal();

    const chips = $("#groupChips");
    chips.innerHTML = "";
    const ep = state.storyboards[state.currentEpisode];
    if (!ep) return;
    const allChip = makeGroupChip("全部", state.currentGroupIdx === -1, () => {
      state.currentGroupIdx = -1;
      renderStoryboardBrowser();
      renderStoryboard();
    });
    chips.appendChild(allChip);
    ep.groups.forEach((g, i) => {
      const chip = makeGroupChip("第" + (i + 1) + "组", state.currentGroupIdx === i, () => {
        state.currentGroupIdx = i;
        renderStoryboardBrowser();
        renderStoryboard();
      });
      chips.appendChild(chip);
    });

    const total = ep.groups.length;
    $("#groupIndicator").textContent = state.currentGroupIdx === -1
      ? "全部 " + total + " 组"
      : "第 " + (state.currentGroupIdx + 1) + " / " + total + " 组";
    $("#prevGroup").disabled = state.currentGroupIdx <= 0;
    $("#nextGroup").disabled = state.currentGroupIdx === -1 || state.currentGroupIdx >= total - 1;
    $("#toggleAllGroups").textContent = state.currentGroupIdx === -1 ? "单组浏览" : "显示全部组";
  }

  function makeGroupChip(text, active, fn) {
    const b = document.createElement("button");
    b.className = "g-chip" + (active ? " active" : "");
    b.textContent = text;
    b.addEventListener("click", fn);
    return b;
  }

  function renderStoryboard() {
    const ep = state.storyboards[state.currentEpisode];
    const wrap = $("#storyboardGroups");
    wrap.innerHTML = "";
    if (!ep) return;
    $("#storyboardMeta").textContent =
      "集数：" + state.currentEpisode + " · 共 " + ep.groups.length + " 组 · " +
      new Date(ep.time).toLocaleString() + (ep.mock ? "（演示模式）" : "");

    const groups = ep.groups;
    if (state.currentGroupIdx === -1) {
      groups.forEach((g, i) => wrap.appendChild(buildGroupCard(g, i, false)));
    } else if (groups[state.currentGroupIdx]) {
      wrap.appendChild(buildGroupCard(groups[state.currentGroupIdx], state.currentGroupIdx, true));
    }
    saveLocal();
  }

  function buildGroupCard(text, idx, single) {
    const div = document.createElement("div");
    div.className = "story-group" + (single ? " single" : "");
    const title = document.createElement("div");
    title.className = "group-title";
    const t = document.createElement("span");
    t.textContent = "第 " + (idx + 1) + " 组";
    const copy = document.createElement("button");
    copy.className = "mini-btn group-copy";
    copy.textContent = "复制本组";
    copy.addEventListener("click", () => copyText(text, "本组已复制"));
    const edit = document.createElement("button");
    edit.className = "mini-btn";
    edit.textContent = "✏️ 改写";
    edit.addEventListener("click", () => openShotModal(state.currentEpisode, idx));
    title.append(t, edit, copy);
    const body = document.createElement("div");
    body.textContent = text;
    div.append(title, body);
    return div;
  }

  $("#episodeSelectMain").addEventListener("change", (e) => {
    state.currentEpisode = e.target.value;
    state.currentGroupIdx = -1;
    renderStoryboardBrowser();
    renderStoryboard();
  });
  $("#prevGroup").addEventListener("click", () => {
    if (state.currentGroupIdx > 0) {
      state.currentGroupIdx--;
      renderStoryboardBrowser();
      renderStoryboard();
    }
  });
  $("#nextGroup").addEventListener("click", () => {
    const ep = state.storyboards[state.currentEpisode];
    if (ep && state.currentGroupIdx < ep.groups.length - 1) {
      state.currentGroupIdx++;
      renderStoryboardBrowser();
      renderStoryboard();
    }
  });
  $("#toggleAllGroups").addEventListener("click", () => {
    state.currentGroupIdx = state.currentGroupIdx === -1 ? 0 : -1;
    renderStoryboardBrowser();
    renderStoryboard();
  });
  $("#copyStoryboard").addEventListener("click", () => {
    const ep = state.storyboards[state.currentEpisode];
    if (!ep) return;
    const text = state.currentGroupIdx === -1 ? ep.text : ep.groups[state.currentGroupIdx];
    copyText(text, state.currentGroupIdx === -1 ? "分镜全文已复制" : "当前组已复制");
  });
  $("#exportStoryboard").addEventListener("click", () => {
    const ep = state.storyboards[state.currentEpisode];
    if (!ep) { toast("暂无可导出的分镜", "error"); return; }
    const blob = new Blob([ep.text], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "漫剧分镜_" + state.currentEpisode + ".txt";
    a.click();
    URL.revokeObjectURL(a.href);
    toast("已导出「" + state.currentEpisode + "」.txt", "success");
  });

  // ---------------- 自定义改写分镜 ----------------
  let shotEditState = null;
  function openShotModal(episode, index) {
    const ep = state.storyboards[episode];
    if (!ep) { toast("请先生成该集分镜", "error"); return; }
    shotEditState = { episode, index };
    $("#shotModalTitle").textContent = "自定义改写分镜：" + episode + " · 第" + (index + 1) + "组";
    $("#shotCurrent").textContent = ep.groups[index] || "";
    $("#shotInput").value = "";
    $("#shotResult").classList.add("hidden");
    $("#shotModal").classList.remove("hidden");
    setTimeout(() => { try { $("#shotInput").focus(); } catch (e) {} }, 60);
  }
  $("#genShotPrompt").addEventListener("click", async () => {
    const shot = $("#shotInput").value.trim();
    if (!shot) { toast("请先粘贴你的分镜草稿", "error"); return; }
    const btn = $("#genShotPrompt");
    btn.disabled = true;
    $("#shotLoading").classList.remove("hidden");
    try {
      const data = await api("/api/storyboard_prompt", {
        user_shot: shot,
        style: state.style,
        mock: state.mock,
        provider_id: state.activeProvider,
      });
      $("#shotResultText").textContent = data.text;
      $("#shotResult").classList.remove("hidden");
      toast("分镜提示词生成完成" + (data.mock ? "（演示）" : ""), "success");
    } catch (e) {
      toast("生成失败：" + friendlyError(e.message), "error");
    } finally {
      btn.disabled = false;
      $("#shotLoading").classList.add("hidden");
    }
  });
  $("#replaceGroup").addEventListener("click", () => {
    const text = $("#shotResultText").textContent;
    if (!shotEditState || !text) { toast("请先生成分镜提示词", "error"); return; }
    const ep = state.storyboards[shotEditState.episode];
    if (!ep) return;
    ep.groups[shotEditState.index] = text;
    ep.text = ep.groups.map((g, i) => {
      const t = g.trim();
      return /^第\s*\d+\s*组/.test(t) ? t : "第" + (i + 1) + "组\n" + t;
    }).join("\n");
    renderStoryboardBrowser();
    renderStoryboard();
    $("#shotModal").classList.add("hidden");
    toast("已替换第" + (shotEditState.index + 1) + "组", "success");
    saveLocal();
  });
  $("#copyShotResult").addEventListener("click", () => copyText($("#shotResultText").textContent, "分镜提示词已复制"));
  $("#closeShot").addEventListener("click", () => $("#shotModal").classList.add("hidden"));
  $("#closeShot2").addEventListener("click", () => $("#shotModal").classList.add("hidden"));
  $("#shotModal").addEventListener("click", (e) => {
    if (e.target === $("#shotModal")) $("#shotModal").classList.add("hidden");
  });

  // ---------------- 规则弹窗 ----------------
  $("#viewRules").addEventListener("click", async () => {
    try {
      const data = await api("/api/rules", {});
      $("#rulesText").value = data.rules;
      $("#rulesModal").classList.remove("hidden");
      $("#rulesText").focus();
    } catch (e) {
      toast("读取规则失败：" + e.message, "error");
    }
  });
  $("#saveRules").addEventListener("click", async () => {
    const rules = $("#rulesText").value;
    if (!rules.trim()) { toast("规则内容不能为空", "error"); return; }
    try {
      await api("/api/rules", { rules });
      $("#rulesModal").classList.add("hidden");
      toast("分镜规则已保存，后续生成将按新规则执行", "success");
    } catch (e) {
      toast("保存失败：" + e.message, "error");
    }
  });
  $("#resetRules").addEventListener("click", async () => {
    if (!confirm("确定恢复默认分镜规则？当前修改将丢失。")) return;
    try {
      const data = await api("/api/rules", { reset: true });
      $("#rulesText").value = data.rules;
      toast("已恢复默认规则", "success");
    } catch (e) {
      toast("恢复失败：" + e.message, "error");
    }
  });
  $("#closeRules").addEventListener("click", () => $("#rulesModal").classList.add("hidden"));
  $("#closeRules2").addEventListener("click", () => $("#rulesModal").classList.add("hidden"));
  $("#rulesModal").addEventListener("click", (e) => {
    if (e.target === $("#rulesModal")) $("#rulesModal").classList.add("hidden");
  });
  $("#addAssetModal").addEventListener("click", (e) => {
    if (e.target === $("#addAssetModal")) $("#addAssetModal").classList.add("hidden");
  });

  function currentProviderLabel() {
    return (state.config && state.config.providers[state.activeProvider] || {}).name || "模型";
  }

  function showFatal(msg) {
    document.body.innerHTML =
      '<div class="fatal"><div class="fatal-card">' +
      '<div class="fatal-icon">⚠️</div>' +
      "<h3>无法连接本地服务</h3>" +
      '<p>' + msg + "</p>" +
      '<button class="btn primary big" onclick="location.reload()">重新检测</button>' +
      "</div></div>";
  }

  async function probeServer() {
    try {
      const resp = await fetch("/api/config", { signal: AbortSignal.timeout(3500) });
      if (resp.status === 401) return true; // 服务在，但需要访问密码 → 走服务模式登录
      if (!resp.ok) return false;
      const data = await resp.json();
      return !!(data && data.config && data.config.providers);
    } catch (e) {
      return false;
    }
  }

  // ---------------- 初始化 ----------------
  async function init() {
    loadLocal();
    $("#appVersion").textContent = APP_VERSION;

    // 无本地服务时自动进入便携模式（双击文件 / 部署到静态托管如 pages.dev）
    if (location.protocol === "file:" || !(await probeServer())) {
      DIRECT = true;
      await loadConfig();
      $("#scriptInput").value = state.script;
      $("#scriptCount").textContent = state.script.length + " 字";
      if (state.style) {
        $$(".style-card").forEach((c) => c.classList.toggle("selected", c.dataset.style === state.style));
      }
      $("#demoMode").checked = state.mock;
      if (!Object.keys(state.storyboards).length) {
        renderEpisodeSelectLocal();
      }
      if (flattenAssets().length) {
        $("#assetSection").classList.remove("hidden");
        renderAssets();
        renderPromptAssetList();
        renderVerifyResult();
      }
      if (Object.keys(state.storyboards).length) {
        renderStoryboardBrowser();
        renderStoryboard();
        $("#storyboardResult").classList.remove("hidden");
      }
      updateProviderBadge();
      return;
    }

    let resp;
    try {
      resp = await fetch("/api/config");
    } catch (e) {
      showFatal("没有检测到本地服务。<br>请双击 <b>启动工作站.bat</b> 启动网站，并保持黑色窗口一直打开（关闭窗口 = 关闭网站）。<br>启动后浏览器会自动打开 http://127.0.0.1:8787，再刷新本页面即可。");
      return;
    }
    if (resp.status === 401) { showLogin(); return; }

    await loadConfig();

    $("#scriptInput").value = state.script;
    $("#scriptCount").textContent = state.script.length + " 字";
    if (state.style) {
      $$(".style-card").forEach((c) => c.classList.toggle("selected", c.dataset.style === state.style));
    }
    $("#demoMode").checked = state.mock;
    if (!Object.keys(state.storyboards).length) {
      renderEpisodeSelectLocal();
    }

    if (flattenAssets().length) {
      $("#assetSection").classList.remove("hidden");
      renderAssets();
      renderPromptAssetList();
      renderVerifyResult();
    }
    if (Object.keys(state.storyboards).length) {
      renderStoryboardBrowser();
      renderStoryboard();
      $("#storyboardResult").classList.remove("hidden");
    }
    updateProviderBadge();
  }

  init();
})();
