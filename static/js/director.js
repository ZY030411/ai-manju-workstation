(function () {
  "use strict";

  const P = window.MANJU_PROMPTS || {};
  const STORAGE_KEY = "manju_director_project_v1";
  const THEME_KEY = "manju_director_theme_v1";
  const MODEL_KEY = "manju_config";
  const RULES_KEY = "manju_rules";
  const MAX_CONCURRENT_EPISODES = 2;
  const MAX_GROUPS = 15;
  const MIN_GROUPS = 8;
  const MAX_SHOTS = 6;
  const MIN_SHOTS = 4;
  const MAX_GROUP_SECONDS = 15;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const uid = (prefix) => prefix + "_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const numberValue = (value, fallback) => {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const CN_DIGITS = { "零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10, "百": 100 };

  let state = emptyState();
  let scanDraft = null;
  let selection = new Set();
  let activeGroupIndex = 0;
  let activeShotId = "";
  let currentReferenceType = "character";
  let referenceQuery = "";
  let saveTimer = null;
  let toastTimer = null;
  let generationRun = null;
  let rewriteController = null;
  let modelDraftConfig = null;
  let activeModelProviderId = "deepseek";
  let previousFocus = null;

  function emptyState() {
    return {
      schemaVersion: 2,
      project: {
        id: uid("project"),
        name: "",
        format: "vertical",
        script: "",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      episodes: [],
      activeEpisodeId: "",
      rules: P.rules || "",
    };
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function safeJsonParse(value) {
    try {
      return JSON.parse(value);
    } catch (_error) {
      return null;
    }
  }

  function getEpisode() {
    return state.episodes.find((episode) => episode.id === state.activeEpisodeId) || state.episodes[0] || null;
  }

  function getActiveGroup() {
    const episode = getEpisode();
    return episode && episode.groups ? episode.groups[activeGroupIndex] || null : null;
  }

  function getActiveShot() {
    const group = getActiveGroup();
    return group && group.shots ? group.shots.find((shot) => shot.id === activeShotId) || null : null;
  }

  function normalizeState(raw) {
    if (!raw || typeof raw !== "object") return emptyState();
    const next = emptyState();
    next.project = Object.assign(next.project, raw.project || {});
    next.project.id = next.project.id || uid("project");
    next.project.format = next.project.format === "horizontal" ? "horizontal" : "vertical";
    next.project.name = String(next.project.name || "");
    next.project.script = String(next.project.script || "");
    next.rules = typeof raw.rules === "string" ? raw.rules : (P.rules || "");
    next.episodes = Array.isArray(raw.episodes) ? raw.episodes.map((episode, index) => normalizeEpisode(episode, index)) : [];
    const activeExists = next.episodes.some((episode) => episode.id === raw.activeEpisodeId);
    next.activeEpisodeId = activeExists ? raw.activeEpisodeId : (next.episodes[0] ? next.episodes[0].id : "");
    return next;
  }

  function normalizeEpisode(raw, index) {
    const episode = raw && typeof raw === "object" ? raw : {};
    const groups = Array.isArray(episode.groups) ? episode.groups.map((group, groupIndex) => normalizeGroup(group, groupIndex)) : [];
    return {
      id: String(episode.id || uid("episode")),
      name: String(episode.name || "第" + (index + 1) + "集"),
      order: Number.isFinite(Number(episode.order)) ? Number(episode.order) : index + 1,
      script: String(episode.script || ""),
      status: ["ready", "generating", "generated", "failed"].includes(episode.status) ? episode.status : (groups.length ? "generated" : "ready"),
      groups,
      error: String(episode.error || ""),
      validation: String(episode.validation || ""),
      updatedAt: String(episode.updatedAt || ""),
    };
  }

  function normalizeGroup(raw, index) {
    const group = raw && typeof raw === "object" ? raw : {};
    const shots = Array.isArray(group.shots) ? group.shots.map((shot, shotIndex) => normalizeShot(shot, shotIndex)) : [];
    return {
      id: String(group.id || uid("group")),
      title: String(group.title || "第" + (index + 1) + "组"),
      duration: numberValue(group.duration, totalDuration(shots)),
      location: String(group.location || ""),
      emotion: String(group.emotion || ""),
      shots,
    };
  }

  function normalizeShot(raw, index) {
    const shot = raw && typeof raw === "object" ? raw : {};
    return {
      id: String(shot.id || uid("shot")),
      shotNo: Number.isFinite(Number(shot.shotNo)) ? Number(shot.shotNo) : index + 1,
      size: String(shot.size || "中景"),
      angle: String(shot.angle || "平拍"),
      movement: String(shot.movement || "固定"),
      duration: clamp(numberValue(shot.duration, 2.5), 0.5, 20),
      visual: String(shot.visual || ""),
      dialogue: String(shot.dialogue || ""),
      lighting: String(shot.lighting || ""),
      effects: String(shot.effects || ""),
      prompt: String(shot.prompt || ""),
      idea: String(shot.idea || ""),
      references: Array.isArray(shot.references)
        ? shot.references
            .filter((reference) => reference && reference.dataUrl)
            .slice(0, 4)
            .map((reference) => ({
              id: String(reference.id || uid("reference")),
              name: String(reference.name || "参考图"),
              type: ["character", "scene", "prop"].includes(reference.type) ? reference.type : "character",
              dataUrl: String(reference.dataUrl),
              note: String(reference.note || ""),
            }))
        : [],
    };
  }

  function totalDuration(shots) {
    return (shots || []).reduce((sum, shot) => sum + numberValue(shot.duration, 0), 0);
  }

  function loadStoredProject() {
    const saved = safeJsonParse(localStorage.getItem(STORAGE_KEY) || "");
    return saved ? normalizeState(saved) : emptyState();
  }

  function setSaveState(mode, text) {
    const element = $("#saveState");
    if (!element) return;
    element.classList.remove("saving", "error");
    if (mode) element.classList.add(mode);
    element.textContent = text || (mode === "saving" ? "正在保存" : mode === "error" ? "保存失败" : "自动保存");
  }

  function saveProject(immediate) {
    clearTimeout(saveTimer);
    setSaveState("saving", "正在保存");
    const task = () => {
      try {
        state.project.updatedAt = new Date().toISOString();
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        setSaveState("", "已保存");
      } catch (error) {
        setSaveState("error", "保存失败");
        showToast("浏览器存储空间不足，请删除部分参考图后再试。", true);
      }
    };
    if (immediate) task();
    else saveTimer = setTimeout(task, 280);
  }

  function showToast(message, isError) {
    const toast = $("#toast");
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.toggle("error", Boolean(isError));
    toast.classList.add("show");
    toastTimer = setTimeout(() => toast.classList.remove("show"), isError ? 4800 : 2800);
  }

  function setTheme(theme) {
    const next = theme === "light" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem(THEME_KEY, next);
    const button = $("#themeToggle");
    const meta = $('meta[name="theme-color"]');
    if (button) {
      button.title = next === "dark" ? "切换为白天模式" : "切换为夜晚模式";
      button.setAttribute("aria-label", button.title);
      button.innerHTML = '<svg><use href="#i-' + (next === "dark" ? "sun" : "moon") + '"></use></svg>';
    }
    if (meta) meta.content = next === "dark" ? "#0e0d0c" : "#f1eee8";
  }

  function cnToInt(value) {
    const source = String(value || "");
    if (/^\d+$/.test(source)) return Number.parseInt(source, 10);
    let result = 0;
    let current = 0;
    for (const character of source) {
      const digit = CN_DIGITS[character];
      if (digit === undefined) return null;
      if (digit === 100) {
        result += (current || 1) * 100;
        current = 0;
      } else if (digit === 10) {
        result += (current || 1) * 10;
        current = 0;
      } else {
        current = digit;
      }
    }
    return result + current || null;
  }

  function episodeHeading(line) {
    const text = String(line || "").trim();
    let match = text.match(/^(?:[【\[]\s*)?第\s*([零〇一二两三四五六七八九十百\d]+)\s*([集章话卷])(?:\s*[】\]])?(?:(?:\s*[·:：—\-]\s*|\s+).*)?$/);
    if (match) {
      const number = cnToInt(match[1]);
      if (number) return "第" + number + match[2];
      return "第" + match[1] + match[2];
    }
    match = text.match(/^(?:EP|E)\s*0*(\d{1,4})(?:(?:\s*[·:：—\-]\s*|\s+).*)?$/i);
    if (match) return "第" + Number(match[1]) + "集";
    return "";
  }

  function splitEpisodes(script) {
    const text = String(script || "").replace(/\r\n?/g, "\n");
    const lines = text.split("\n");
    const segments = [];
    let current = null;

    const flush = () => {
      if (current && current.lines.some((line) => line.trim())) {
        segments.push({ name: current.name, script: current.lines.join("\n").trim() });
      }
      current = null;
    };

    lines.forEach((line) => {
      const name = episodeHeading(line);
      if (name) {
        flush();
        current = { name, lines: [line] };
      } else if (current) {
        current.lines.push(line);
      } else if (!segments.length && line.trim()) {
        current = { name: "第1集", lines: [line] };
      }
    });
    flush();

    if (!segments.length) {
      const sceneGroups = new Map();
      let inferredOrder = 1;
      lines.forEach((line) => {
        const match = line.trim().match(/^(\d{1,3})\s*[-－—]\s*\d{1,3}(?:\s*[日夜晨昏傍晚凌晨]*\s*[内外]?\s*)/);
        if (match) inferredOrder = Number(match[1]);
        if (!sceneGroups.has(inferredOrder)) sceneGroups.set(inferredOrder, []);
        sceneGroups.get(inferredOrder).push(line);
      });
      if (text.trim()) {
        if (sceneGroups.size > 1) {
          Array.from(sceneGroups.keys()).sort((a, b) => a - b).forEach((order) => {
            segments.push({ name: "第" + order + "集", script: sceneGroups.get(order).join("\n").trim() });
          });
        } else {
          segments.push({ name: "第1集", script: text.trim() });
        }
      }
    }

    const merged = [];
    const byName = new Map();
    segments.forEach((segment, index) => {
      if (byName.has(segment.name)) {
        byName.get(segment.name).script += "\n" + segment.script;
        return;
      }
      const episode = {
        id: uid("episode"),
        name: segment.name,
        order: index + 1,
        script: segment.script,
        status: "ready",
        groups: [],
        error: "",
        validation: "",
      };
      byName.set(segment.name, episode);
      merged.push(episode);
    });
    return merged;
  }

  function sceneHeaders(script) {
    const results = [];
    String(script || "").replace(/\r\n?/g, "\n").split("\n").forEach((line) => {
      const match = line.trim().match(/^(\d{1,3})\s*[-－—]\s*(\d{1,3})\s*([日昼夜晨昏傍晚凌晨]*)\s*([内外])?\s*[：:]?\s*(.+?)\s*$/);
      if (!match || !match[5]) return;
      let name = match[5].replace(/[，,。；;].*$/, "").trim();
      if (!name || name.length > 24) return;
      results.push({
        episode: Number(match[1]),
        sceneNo: Number(match[2]),
        name,
        period: match[3] || "",
        place: match[4] || "",
        key: name,
      });
    });
    return results;
  }

  function scriptSpeakers(script) {
    const ignored = new Set(["系统", "系统OS", "系统提示", "旁白", "画外音", "内心", "内心OS", "OS", "所需材料", "特性", "提示"]);
    const names = new Set();
    String(script || "").replace(/\r\n?/g, "\n").split("\n").forEach((line) => {
      const match = line.match(/^\s*([^：:\n]{1,16})[：:]\s*\S+/);
      if (!match) return;
      let name = match[1]
        .replace(/[（(【\[][^）)】\]]*[）)】\]]/g, "")
        .replace(/(OS|内心|独白|心声|旁白)$/i, "")
        .replace(/[，,。！？!?：:、\s]/g, "")
        .trim();
      if (!name || name.length > 8 || ignored.has(name)) return;
      if (/^(场景|地点|时间|人物|剧情|分镜|画面|镜头|字幕|背景|环境)$/.test(name)) return;
      names.add(name);
    });
    return Array.from(names);
  }

  function scanStats(script, episodes) {
    const scenes = sceneHeaders(script);
    const sceneNames = new Set(scenes.map((scene) => scene.name));
    return {
      characters: scriptSpeakers(script).length,
      scenes: sceneNames.size,
      sceneHeaders: scenes.length,
      chars: String(script || "").length,
      lines: String(script || "").split(/\r?\n/).length,
      episodes: episodes.length,
    };
  }

  function updateScriptMetrics() {
    const text = $("#scriptInput").value;
    $("#scriptChars").textContent = String(text.length);
    $("#scriptLines").textContent = String(text ? text.split(/\r?\n/).length : 0);
    $("#scriptFileState").textContent = text.trim() ? "剧本已载入" : "等待剧本";
  }

  function setScanSummary(episodes, stats, projectName) {
    const summary = $("#scanSummary");
    if (!episodes.length) {
      summary.innerHTML = '<div class="summary-empty"><svg><use href="#i-film"></use></svg><strong>识别后显示剧本概况</strong><span>集数、场次、人物与场景线索会在这里汇总。</span></div>';
      return;
    }
    summary.innerHTML =
      '<div class="scan-content">' +
        '<div class="summary-main"><strong>' + escapeHtml(projectName || "未命名项目") + '</strong><span>已锁定 ' + stats.episodes + ' 个独立集/章节，生成时每集单独请求。</span></div>' +
        '<div class="scan-stat"><b>' + stats.episodes + '</b><span>集 / 章节</span></div>' +
        '<div class="scan-stat"><b>' + stats.sceneHeaders + '</b><span>场次编号</span></div>' +
        '<div class="scan-stat"><b>' + stats.scenes + '</b><span>合并后场景</span></div>' +
        '<div class="scan-stat"><b>' + stats.characters + '</b><span>对白角色线索</span></div>' +
      '</div>';
  }

  async function scanScript() {
    clearTimeout(toastTimer);
    const script = $("#scriptInput").value.trim();
    if (!script) {
      showToast("请先粘贴剧本或导入文本文件。", true);
      $("#scriptInput").focus();
      return;
    }

    const overlay = $("#scanOverlay");
    overlay.hidden = false;
    const stage = $("#scanStage");
    const progress = $("#scanProgress");
    const meta = $("#scanMeta");
    const stages = [
      ["定位集数标题", "正在识别「第1集 / 第一集 / EP01 / E01」"],
      ["核对场次边界", "正在读取「1-1 日夜 内外 场景」场次编号"],
      ["索引人物与场景", "正在建立剧本资产线索"],
      ["锁定分集结构", "正在检查重复标题与空段"],
    ];

    for (let index = 0; index < stages.length; index += 1) {
      stage.textContent = stages[index][0];
      meta.textContent = stages[index][1];
      progress.style.width = String(Math.round(((index + 1) / stages.length) * 100)) + "%";
      await sleep(index === 0 ? 330 : 270);
    }

    const episodes = splitEpisodes(script);
    const stats = scanStats(script, episodes);
    scanDraft = { episodes, stats, script };
    setScanSummary(episodes, stats, $("#projectNameInput").value.trim());
    $("#proofEpisodes").textContent = stats.episodes + " 集";
    $("#enterWorkspace").disabled = false;
    stage.textContent = "识别完成";
    meta.textContent = "已识别 " + stats.episodes + " 集、" + stats.sceneHeaders + " 个场次编号";
    await sleep(360);
    overlay.hidden = true;
    showToast("已锁定 " + stats.episodes + " 集；可在进入导演台后自由勾选。");
  }

  function setDirection(format) {
    const next = format === "horizontal" ? "horizontal" : "vertical";
    state.project.format = next;
    $$(".format-option").forEach((option) => {
      const selected = option.dataset.format === next;
      option.classList.toggle("selected", selected);
      option.setAttribute("aria-checked", String(selected));
    });
    if (scanDraft) setScanSummary(scanDraft.episodes, scanDraft.stats, $("#projectNameInput").value.trim());
    saveProject();
  }

  function enterWorkspace() {
    const script = $("#scriptInput").value.trim();
    if (!script) return;
    if (!scanDraft || scanDraft.script !== script) {
      showToast("剧本内容已变化，请先重新识别。", true);
      scanDraft = null;
      $("#enterWorkspace").disabled = true;
      return;
    }

    const oldByName = new Map(state.episodes.map((episode) => [episode.name, episode]));
    const episodes = scanDraft.episodes.map((scanned, index) => {
      const previous = oldByName.get(scanned.name);
      return {
        ...scanned,
        id: previous ? previous.id : scanned.id,
        order: index + 1,
        groups: previous && previous.script === scanned.script ? previous.groups : scanned.groups,
        status: previous && previous.script === scanned.script && previous.groups.length ? previous.status : "ready",
        validation: previous && previous.script === scanned.script ? previous.validation : "",
      };
    });

    state.project.name = $("#projectNameInput").value.trim() || "未命名漫剧项目";
    state.project.script = script;
    state.project.updatedAt = new Date().toISOString();
    state.episodes = episodes;
    state.activeEpisodeId = episodes[0] ? episodes[0].id : "";
    state.rules = state.rules || P.rules || "";
    selection = new Set();
    activeGroupIndex = 0;
    activeShotId = "";
    saveProject(true);
    showDirector();
    showToast("导演台已就绪。勾选单集或多集后开始生成。");
  }

  function showSetup(blank) {
    $("#setupView").hidden = false;
    $("#directorView").hidden = true;
    document.body.classList.remove("director-mode");
    if (blank) {
      state = emptyState();
      scanDraft = null;
      selection = new Set();
      $("#projectNameInput").value = "";
      $("#scriptInput").value = "";
      $("#enterWorkspace").disabled = true;
      $("#proofEpisodes").textContent = "待导入";
      setScanSummary([], null, "");
      setDirection("vertical");
    } else {
      $("#projectNameInput").value = state.project.name || "";
      $("#scriptInput").value = state.project.script || "";
      if (state.episodes.length) {
        scanDraft = {
          episodes: state.episodes,
          stats: scanStats(state.project.script, state.episodes),
          script: state.project.script,
        };
        setScanSummary(scanDraft.episodes, scanDraft.stats, state.project.name);
        $("#proofEpisodes").textContent = scanDraft.stats.episodes + " 集";
        $("#enterWorkspace").disabled = !state.project.script;
      }
      setDirection(state.project.format);
    }
    updateScriptMetrics();
    renderProjectCrumb();
  }

  function showDirector() {
    const episode = getEpisode();
    if (!episode) {
      showSetup(false);
      return;
    }
    $("#setupView").hidden = true;
    $("#directorView").hidden = false;
    document.body.classList.add("director-mode");
    state.activeEpisodeId = episode.id;
    const savedShot = getActiveShot();
    activeGroupIndex = clamp(activeGroupIndex, 0, Math.max(0, episode.groups.length - 1));
    if (!savedShot) activeShotId = episode.groups[0] && episode.groups[0].shots[0] ? episode.groups[0].shots[0].id : "";
    syncResponsiveWorkspace();
    renderWorkspace();
  }

  function renderProjectCrumb() {
    $(".crumb-name").textContent = state.project.name || "尚未创建项目";
  }

  function renderWorkspace() {
    renderProjectCrumb();
    const episode = getEpisode();
    const shotTotal = state.episodes.reduce((sum, item) => sum + item.groups.reduce((groupSum, group) => groupSum + group.shots.length, 0), 0);
    const generated = state.episodes.filter((item) => item.status === "generated" && item.groups.length).length;
    $("#projectMeta").textContent = (state.project.format === "vertical" ? "竖屏 9:16" : "横屏 16:9") + " · " + state.episodes.length + " 集";
    $("#episodeCount").textContent = String(state.episodes.length);
    $("#generatedCount").textContent = String(generated);
    $("#shotCount").textContent = String(shotTotal);
    renderEpisodeList();
    renderCurrentEpisode();
    renderGenerationState();
  }

  function episodeStatusLabel(episode) {
    if (episode.status === "generating") return "编排中";
    if (episode.status === "failed") return "失败";
    if (episode.status === "generated" || episode.groups.length) return episode.groups.length + " 组";
    return "待生成";
  }

  function renderEpisodeList() {
    const query = ($("#episodeSearch").value || "").trim().toLowerCase();
    const visible = state.episodes.filter((episode) => !query || episode.name.toLowerCase().includes(query));
    const validIds = new Set(state.episodes.map((episode) => episode.id));
    selection = new Set(Array.from(selection).filter((id) => validIds.has(id)));

    if (!visible.length) {
      $("#episodeList").innerHTML = '<div class="list-empty">没有找到匹配的集数</div>';
    } else {
      $("#episodeList").innerHTML = visible.map((episode) => {
        const active = episode.id === state.activeEpisodeId;
        return (
          '<div class="episode-item' + (active ? " active" : "") + '" role="button" tabindex="0" data-episode-id="' + escapeHtml(episode.id) + '">' +
            '<input type="checkbox" aria-label="选择 ' + escapeHtml(episode.name) + '" data-select-episode="' + escapeHtml(episode.id) + '"' + (selection.has(episode.id) ? " checked" : "") + '>' +
            '<span class="episode-item-copy"><strong>' + escapeHtml(episode.name) + '</strong><span>' + episode.script.length + ' 字 · ' + (episode.groups.length ? episode.groups.length + " 组镜头" : "尚未编排") + '</span></span>' +
            '<span class="episode-status ' + escapeHtml(episode.status) + '">' + escapeHtml(episodeStatusLabel(episode)) + '</span>' +
          '</div>'
        );
      }).join("");
    }

    const selectedVisible = visible.filter((episode) => selection.has(episode.id));
    const all = $("#selectAllEpisodes");
    all.checked = visible.length > 0 && selectedVisible.length === visible.length;
    all.indeterminate = selectedVisible.length > 0 && selectedVisible.length < visible.length;
    $("#selectedEpisodeCount").textContent = "已选 " + selection.size + " 集";
  }

  function renderCurrentEpisode() {
    const episode = getEpisode();
    if (!episode) return;
    $("#currentEpisodeTitle").textContent = episode.name;
    const groupCount = episode.groups.length;
    const shotCount = episode.groups.reduce((sum, group) => sum + group.shots.length, 0);
    const validation = episode.validation ? " · " + episode.validation : "";
    const error = episode.error ? " · " + episode.error : "";
    $("#currentEpisodeMeta").textContent = groupCount
      ? "共 " + groupCount + " 组 / " + shotCount + " 镜" + validation + error + " · " + (state.project.format === "vertical" ? "9:16 竖屏" : "16:9 横屏")
      : "本集尚未生成。可单独生成，也可在左侧勾选多集批量生成。" + error;
    $("#generateCurrentEpisode").disabled = !episode || episode.status === "generating";
    $("#emptyGenerateButton").disabled = !episode || episode.status === "generating";
    $("#retryEpisode").hidden = episode.status !== "failed";

    if (!episode.groups.length) {
      $("#emptyStoryboard").hidden = false;
      $("#storyboardWorkspace").hidden = true;
      return;
    }
    $("#emptyStoryboard").hidden = true;
    $("#storyboardWorkspace").hidden = false;
    activeGroupIndex = clamp(activeGroupIndex, 0, episode.groups.length - 1);
    renderGroupTabs();
    renderGroup();
  }

  function renderGroupTabs() {
    const episode = getEpisode();
    $("#groupSwitcher").innerHTML = episode.groups.map((group, index) =>
      '<button class="group-tab' + (index === activeGroupIndex ? " active" : "") + '" role="tab" aria-selected="' + (index === activeGroupIndex) + '" data-group-index="' + index + '" draggable="true" title="' + escapeHtml(group.title) + '（拖动排序）">' + escapeHtml(group.title) + '</button>'
    ).join("");
    $("#groupCounter").textContent = (activeGroupIndex + 1) + " / " + episode.groups.length;
  }

  function shotSheetRowMarkup(shot, index) {
    const preview = shot.visual || shot.prompt || "尚未填写画面内容";
    const referenceCount = shot.references.length;
    const referenceSummary = shot.references
      .map((reference) => ({ character: "人物", scene: "场景", prop: "道具" })[reference.type] || "参考")
      .filter((type, typeIndex, types) => types.indexOf(type) === typeIndex)
      .join(" / ");
    return (
      '<div class="shot-sheet-row' + (shot.id === activeShotId ? " active" : "") + '" role="row" tabindex="0" data-shot-id="' + escapeHtml(shot.id) + '" draggable="true" aria-selected="' + (shot.id === activeShotId) + '">' +
        '<div class="shot-sheet-no" role="cell"><span class="shot-drag-handle" aria-hidden="true">⠿</span><small>SHOT</small><b>' + String(index + 1).padStart(2, "0") + '</b></div>' +
        '<div class="shot-sheet-lens" role="cell"><strong>' + escapeHtml(shot.size) + '</strong><span>' + escapeHtml(shot.angle) + '</span><em>' + escapeHtml(shot.movement) + '</em></div>' +
        '<div class="shot-sheet-duration" role="cell"><b>' + escapeHtml(shot.duration) + '</b><span>秒</span></div>' +
        '<div class="shot-sheet-visual" role="cell"><p>' + escapeHtml(preview) + '</p>' + (referenceCount ? '<small>' + escapeHtml(referenceSummary) + '参考 ' + referenceCount + ' 张</small>' : '<small class="muted">无参考图</small>') + '</div>' +
        '<div class="shot-sheet-dialogue" role="cell">' + (shot.dialogue ? '<b>台词</b><p>' + escapeHtml(shot.dialogue) + '</p>' : '<span>无台词 · 以动作和视线承接</span>') + '</div>' +
        '<div class="shot-sheet-light" role="cell"><p>' + escapeHtml(shot.lighting || "未填写光影") + '</p><small>' + escapeHtml(shot.effects || "无明显特效") + '</small></div>' +
        '<div class="shot-sheet-prompt" role="cell"><p>' + escapeHtml(shot.prompt || "尚未填写最终提示词，请在右侧补充或重新生成。") + '</p><span aria-hidden="true">↗</span></div>' +
      '</div>'
    );
  }

  function renderGroup() {
    const group = getActiveGroup();
    if (!group) return;
    $("#groupTitleInput").value = group.title;
    $("#groupLocationInput").value = group.location || "";
    $("#groupEmotionInput").value = group.emotion || "";
    $("#groupDurationInput").value = group.duration || totalDuration(group.shots);
    const referenceCount = group.shots.reduce((count, shot) => count + shot.references.length, 0);
    $("#shotGrid").innerHTML =
      '<div class="shot-sequence-head">' +
        '<div class="shot-sequence-title"><span>DIRECTOR SHEET / 连续导演分镜表</span><strong>' + escapeHtml(group.title) + '</strong></div>' +
        '<div class="shot-sequence-actions"><p>' + group.shots.length + ' 镜 · ' + totalDuration(group.shots).toFixed(1).replace(/\.0$/, "") + ' 秒 · ' + referenceCount + ' 张参考图</p><button type="button" class="sheet-copy-button" data-copy-group><svg><use href="#i-copy"></use></svg>复制本组提示词</button></div>' +
      '</div>' +
      '<div class="shot-sheet-columns" role="row" aria-hidden="true">' +
        '<span>镜号</span><span>景别 / 角度 / 运镜</span><span>时长</span><span>画面与动作</span><span>台词</span><span>光影 / 环境</span><span>最终分镜提示词</span>' +
      '</div>' +
      '<div class="shot-sheet-body" role="rowgroup">' + group.shots.map(shotSheetRowMarkup).join("") + '</div>' +
      '<button class="shot-sheet-add" type="button" data-action="add-shot"><svg><use href="#i-plus"></use></svg>在这组末尾增加镜头，保持整组连续</button>';
    renderTimeline(group);
    if (!group.shots.some((shot) => shot.id === activeShotId)) {
      activeShotId = group.shots[0] ? group.shots[0].id : "";
    }
    renderInspector();
  }

  function renderTimeline(group) {
    const durations = group.shots.map((shot) => numberValue(shot.duration, 2.5));
    const sum = durations.reduce((total, duration) => total + duration, 0);
    $("#timelineTotal").textContent = sum.toFixed(1).replace(/\.0$/, "") + " 秒 / " + group.shots.length + " 镜";
    $("#shotTimeline").innerHTML = durations.map((duration, index) =>
      '<span class="timeline-segment' + (group.shots[index].id === activeShotId ? " active" : "") + '" style="flex:' + Math.max(duration, 1) + ' 1 0" title="镜头 ' + (index + 1) + ' · ' + duration + ' 秒"></span>'
    ).join("");
  }

  function renderInspector() {
    const shot = getActiveShot();
    $("#inspectorEmpty").hidden = Boolean(shot);
    $("#shotForm").hidden = !shot;
    if (!shot) {
      $("#shotInspectorMeta").textContent = "选择画面中的镜头开始修改";
      return;
    }
    $("#shotInspectorMeta").textContent = "只修改当前镜头，其他分镜不受影响";
    $("#shotNumber").textContent = "镜头 " + String(shot.shotNo || 1).padStart(2, "0");
    const form = $("#shotForm");
    ["size", "angle", "movement", "duration", "visual", "dialogue", "lighting", "effects", "prompt"].forEach((name) => {
      if (form.elements[name]) form.elements[name].value = shot[name] == null ? "" : shot[name];
    });
    $("#shotIdea").value = shot.idea || "";
    renderReferences(shot);
  }

  function renderReferences(shot) {
    const list = $("#referenceList");
    const refs = shot ? shot.references : [];
    const typeLabel = { character: "人物", scene: "场景", prop: "道具" };
    const counts = {
      character: refs.filter((reference) => reference.type === "character").length,
      scene: refs.filter((reference) => reference.type === "scene").length,
      prop: refs.filter((reference) => reference.type === "prop").length,
    };
    $("#referenceTypeTabs").innerHTML = ["character", "scene", "prop"].map((type) =>
      '<button type="button" class="' + (type === currentReferenceType ? "active" : "") + '" data-ref-type="' + type + '">' +
        typeLabel[type] + '<span>' + counts[type] + '</span>' +
      '</button>'
    ).join("");
    if (!shot) {
      list.innerHTML = '<span class="reference-empty">选择镜头后管理参考资产</span>';
      return;
    }
    const normalizedQuery = referenceQuery.trim().toLowerCase();
    const visibleReferences = refs.filter((reference) =>
      reference.type === currentReferenceType &&
      (!normalizedQuery || reference.name.toLowerCase().includes(normalizedQuery))
    );
    list.innerHTML = visibleReferences.map((reference) =>
      '<div class="reference-thumb">' +
        '<div class="reference-thumb-image"><img src="' + escapeHtml(reference.dataUrl) + '" alt="' + escapeHtml(reference.name) + '"><span>' + escapeHtml(typeLabel[reference.type] || "参考") + '</span></div>' +
        '<div class="reference-thumb-copy"><strong title="' + escapeHtml(reference.name) + '">' + escapeHtml(reference.name) + '</strong><small>已关联 · 生成时作为视觉依据</small></div>' +
        '<button type="button" data-remove-reference="' + escapeHtml(reference.id) + '" aria-label="删除 ' + escapeHtml(reference.name) + '"><svg><use href="#i-close"></use></svg></button>' +
      '</div>'
    ).join("") +
    '<button type="button" class="reference-add-tile" data-add-reference>' +
      '<svg><use href="#i-image"></use></svg>' +
      '<span>添加' + escapeHtml(typeLabel[currentReferenceType]) + '参考图</span>' +
      '<small>JPG / PNG / WEBP</small>' +
    '</button>';
    if (!visibleReferences.length && normalizedQuery) {
      list.insertAdjacentHTML("afterbegin", '<span class="reference-empty">当前分类没有匹配“' + escapeHtml(referenceQuery.trim()) + '”的资产。</span>');
    }
  }

  function renderGenerationState() {
    const running = Boolean(generationRun);
    $("#generateSelected").disabled = running || !state.episodes.length;
    $("#cancelGeneration").hidden = !running;
    const selectedCount = selection.size;
    $("#generationLabel").textContent = running
      ? "正在生成 " + generationRun.completed + " / " + generationRun.total + " 集"
      : selectedCount
        ? "已选 " + selectedCount + " 集，按集独立生成"
        : "等待选择集数";
    $("#generationPercent").textContent = String(running ? generationRun.percent : 0) + "%";
    $("#generationProgress").style.width = String(running ? generationRun.percent : 0) + "%";
    $("#generationStage").textContent = running
      ? generationRun.stage
      : generationRun && generationRun.summary
        ? generationRun.summary
        : "";
    const percent = running ? generationRun.percent : 0;
    $("#generationOverlayPercent").textContent = percent + "%";
    $("#generationOverlayProgress").style.width = percent + "%";
    $("#generationOverlayStage").textContent = running ? generationRun.stage : "等待开始生成";
  }

  function updateGenerationProgress(stage, completed, total, ticks) {
    if (!generationRun) return;
    generationRun.stage = stage;
    generationRun.completed = completed;
    generationRun.total = total;
    const base = total ? Math.round((completed / total) * 100) : 0;
    const working = Math.min(14, 4 + Math.max(0, ticks || 0) * 2);
    generationRun.percent = completed >= total ? 100 : Math.min(94, base + working);
    $("#generationOverlayTitle").textContent = stage;
    $("#generationOverlayMeta").textContent = "已完成 " + completed + " / " + total + " 集 · 单集失败不会阻塞其他集";
    $("#generationOverlayPercent").textContent = generationRun.percent + "%";
    $("#generationOverlayProgress").style.width = generationRun.percent + "%";
    $("#generationOverlayStage").textContent = stage;
    renderGenerationState();
  }

  function setMobileView(view) {
    const director = $("#directorView");
    director.classList.toggle("show-episodes", view === "episodes");
    director.classList.toggle("show-groups", view === "groups");
    director.classList.toggle("show-detail", view === "detail");
    $$(".mobile-nav button").forEach((button) => button.classList.toggle("active", button.dataset.mobileView === view));
  }

  function syncResponsiveWorkspace() {
    const director = $("#directorView");
    if (window.innerWidth <= 720) {
      const current = ["episodes", "groups", "detail"].find((view) =>
        director.classList.contains("show-" + view)
      );
      setMobileView(current || "groups");
      return;
    }
    director.classList.remove("show-episodes", "show-groups", "show-detail");
    $$(".mobile-nav button").forEach((button) => button.classList.remove("active"));
  }

  function loadModelConfig() {
    const defaults = JSON.parse(JSON.stringify(P.providers || {}));
    const config = {
      active_provider: "deepseek",
      temperature: 0.75,
      max_tokens: 16384,
      vision: false,
      providers: defaults,
    };
    const saved = safeJsonParse(localStorage.getItem(MODEL_KEY) || "{}") || {};
    if (saved.providers && typeof saved.providers === "object") {
      Object.keys(defaults).forEach((providerId) => {
        if (saved.providers[providerId]) Object.assign(defaults[providerId], saved.providers[providerId]);
      });
    }
    ["active_provider", "temperature", "max_tokens", "vision"].forEach((key) => {
      if (saved[key] !== undefined) config[key] = saved[key];
    });
    if (!config.providers[config.active_provider] && config.active_provider !== "demo") {
      config.active_provider = "deepseek";
    }
    return config;
  }

  function saveModelConfig(config) {
    try {
      localStorage.setItem(MODEL_KEY, JSON.stringify(config));
      return true;
    } catch (_error) {
      showToast("模型设置无法写入浏览器存储。", true);
      return false;
    }
  }

  function populateProviderSelect(config) {
    const select = $("#providerSelect");
    const entries = Object.entries(config.providers);
    entries.push(["demo", { name: "演示模式（无需 API）", models: [], model: "local-demo", direct: true }]);
    select.innerHTML = entries.map(([id, provider]) => '<option value="' + escapeHtml(id) + '">' + escapeHtml(provider.name) + '</option>').join("");
    select.value = config.providers[config.active_provider] ? config.active_provider : "demo";
  }

  function captureProviderForm(config, providerId) {
    if (!providerId || providerId === "demo" || !config.providers[providerId]) return;
    const provider = config.providers[providerId];
    provider.base_url = $("#baseUrlInput").value.trim();
    provider.model = $("#modelNameInput").value.trim();
    provider.api_key = $("#apiKeyInput").value;
    config.temperature = numberValue($("#temperatureInput").value, 0.75);
    config.max_tokens = Math.round(numberValue($("#maxTokensInput").value, 16384));
    config.vision = $("#visionInput").checked;
  }

  function renderProviderForm(config, providerId) {
    activeModelProviderId = providerId;
    const provider = config.providers[providerId] || { name: "演示模式", models: [], model: "local-demo" };
    const isDemo = providerId === "demo";
    $("#baseUrlInput").value = isDemo ? "" : (provider.base_url || "");
    $("#apiKeyInput").value = isDemo ? "" : (provider.api_key || "");
    $("#modelNameInput").value = isDemo ? "local-demo" : (provider.model || "");
    $("#temperatureInput").value = config.temperature == null ? 0.75 : config.temperature;
    $("#maxTokensInput").value = config.max_tokens || 16384;
    $("#visionInput").checked = Boolean(config.vision);
    $("#baseUrlInput").disabled = isDemo;
    $("#apiKeyInput").disabled = isDemo;
    $("#modelNameInput").disabled = isDemo;
    $("#visionInput").disabled = isDemo;
    $("#modelNames").innerHTML = (provider.models || []).map((model) => '<option value="' + escapeHtml(model) + '"></option>').join("");
    $("#modelConnectionNotice").innerHTML = isDemo
      ? '<strong>演示模式</strong><span>无需 API，可走通分集、增删、参考图和改写流程。生成内容是本地演示数据，不代表真实模型质量。</span>'
      : '<strong>浏览器直连模型</strong><span>API Key 只保存在当前浏览器。豆包、OpenAI 等接口若未开放跨域，测试会如实报错；可填写你自己的 OpenAI 兼容代理地址。</span>';
    $("#connectionState").className = "connection-state";
    $("#connectionState").textContent = "";
  }

  function openModelModal() {
    previousFocus = document.activeElement;
    modelDraftConfig = loadModelConfig();
    populateProviderSelect(modelDraftConfig);
    renderProviderForm(modelDraftConfig, modelDraftConfig.active_provider);
    openModal("settingsModal");
  }

  function openRulesModal() {
    previousFocus = document.activeElement;
    $("#rulesInput").value = state.rules || P.rules || "";
    $("#rulesFileLabel").textContent = "支持 .txt / .md";
    openModal("rulesModal");
  }

  function openModal(id) {
    const modal = $("#" + id);
    modal.hidden = false;
    document.body.classList.add("modal-open");
    setTimeout(() => {
      const first = modal.querySelector("input:not([disabled]), textarea, select, button");
      if (first) first.focus();
    }, 50);
  }

  function closeModal(id) {
    const modal = $("#" + id);
    if (!modal) return;
    modal.hidden = true;
    if ($$(".modal-backdrop:not([hidden])").length === 0) document.body.classList.remove("modal-open");
    if (previousFocus && typeof previousFocus.focus === "function") previousFocus.focus();
  }

  function getRuntimeProvider() {
    const config = loadModelConfig();
    const providerId = config.providers[config.active_provider] ? config.active_provider : "demo";
    const provider = config.providers[providerId] || { name: "演示模式", model: "local-demo", models: [] };
    return { config, providerId, provider };
  }

  function normalizeEndpoint(baseUrl) {
    const base = String(baseUrl || "").trim().replace(/\/+$/, "");
    if (!base) return "";
    if (/\/chat\/completions$/i.test(base)) return base;
    return base + "/chat/completions";
  }

  function modelErrorMessage(error) {
    const message = error && error.message ? error.message : String(error || "未知错误");
    if (/failed to fetch|networkerror|load failed|network request failed/i.test(message)) {
      return "浏览器无法连接该接口。通常是接口未开放跨域（CORS）或网络不可达；请改用支持浏览器直连的模型，或填写你的兼容代理地址。";
    }
    if (/CORS|cross-origin/i.test(message)) return "接口拒绝了浏览器跨域请求（CORS）。静态网站必须使用允许跨域的兼容接口或代理。";
    if (/401|403/.test(message)) return message + " 请检查 API Key 权限与模型是否已开通。";
    if (/429/.test(message)) return message + " 请求频率或额度受限，请稍后重试。";
    return message;
  }

  async function requestModel(provider, options) {
    if (!provider || !provider.base_url) throw new Error("尚未填写 API 地址。");
    if (!provider.api_key) throw new Error("尚未填写 API Key。");
    if (!provider.model) throw new Error("尚未填写模型名称。");
    const timeoutMs = options.timeoutMs || 180000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("请求超时")), timeoutMs);
    const externalSignal = options.signal;
    const abortFromExternal = () => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener("abort", abortFromExternal, { once: true });
    }
    const payload = {
      model: provider.model,
      messages: options.messages,
      max_tokens: options.maxTokens || 16384,
      stream: false,
    };
    if (!/reasoner|r1/i.test(provider.model)) payload.temperature = options.temperature == null ? 0.75 : options.temperature;
    let response;
    try {
      response = await fetch(normalizeEndpoint(provider.base_url), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + provider.api_key,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (error) {
      if (externalSignal && externalSignal.aborted) throw new DOMException("已取消", "AbortError");
      throw new Error(controller.signal.aborted ? "请求超时或已取消：" + (controller.signal.reason && controller.signal.reason.message ? controller.signal.reason.message : "") : modelErrorMessage(error));
    } finally {
      clearTimeout(timeout);
      if (externalSignal) externalSignal.removeEventListener("abort", abortFromExternal);
    }
    const raw = await response.text();
    let data = safeJsonParse(raw);
    if (!response.ok) {
      const detail = data && data.error ? (data.error.message || data.error) : raw.slice(0, 360);
      throw new Error("接口返回 HTTP " + response.status + "：" + (typeof detail === "string" ? detail : JSON.stringify(detail)));
    }
    const message = data && data.choices && data.choices[0] && data.choices[0].message;
    let content = message && message.content;
    if (Array.isArray(content)) content = content.map((part) => part.text || "").join("");
    if (!content && data && data.output_text) content = data.output_text;
    if (!content) throw new Error("模型未返回可用内容。");
    return String(content);
  }

  async function testConnection() {
    if (!modelDraftConfig) modelDraftConfig = loadModelConfig();
    captureProviderForm(modelDraftConfig, activeModelProviderId);
    const stateElement = $("#connectionState");
    if (activeModelProviderId === "demo") {
      stateElement.className = "connection-state success";
      stateElement.textContent = "演示模式可用，无需连接接口。";
      return;
    }
    const provider = modelDraftConfig.providers[activeModelProviderId];
    if (!provider) {
      stateElement.className = "connection-state error";
      stateElement.textContent = "未找到该模型厂商的配置。";
      return;
    }
    stateElement.className = "connection-state testing";
    stateElement.textContent = "正在发送最小测试请求…";
    $("#testConnection").disabled = true;
    try {
      const reply = await requestModel(provider, {
        messages: [
          { role: "system", content: "这是一次连接测试。只回复两个字：正常。" },
          { role: "user", content: "测试连接" },
        ],
        maxTokens: 16,
        temperature: 0,
        timeoutMs: 30000,
      });
      stateElement.className = "connection-state success";
      stateElement.textContent = "连接成功。模型回复：" + reply.trim().slice(0, 80);
    } catch (error) {
      stateElement.className = "connection-state error";
      stateElement.textContent = modelErrorMessage(error);
    } finally {
      $("#testConnection").disabled = false;
    }
  }

  function saveModelSettings() {
    if (!modelDraftConfig) modelDraftConfig = loadModelConfig();
    captureProviderForm(modelDraftConfig, activeModelProviderId);
    modelDraftConfig.active_provider = activeModelProviderId;
    if (!saveModelConfig(modelDraftConfig)) return;
    closeModal("settingsModal");
    showToast(activeModelProviderId === "demo" ? "已切换到演示模式。" : "模型设置已保存在当前浏览器。");
  }

  function extractJson(text) {
    const clean = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    try {
      return JSON.parse(clean);
    } catch (_error) {
      const start = clean.indexOf("{");
      const end = clean.lastIndexOf("}");
      if (start === -1 || end <= start) throw new Error("模型输出中没有找到 JSON。");
      const candidate = clean.slice(start, end + 1).replace(/,\s*([}\]])/g, "$1");
      try {
        return JSON.parse(candidate);
      } catch (error) {
        throw new Error("模型输出 JSON 格式不完整：" + error.message);
      }
    }
  }

  function configuredStoryboardRules(maxLength) {
    return String(state.rules || P.rules || "").trim().slice(0, maxLength || 14000);
  }

  function directorSystemPrompt(groupStart, groupCount, segmentNote) {
    const configurableRules = configuredStoryboardRules(16000);
    return [
      "你是 AI 漫剧导演级分镜师。你只处理当前提供的一集剧本，绝对禁止混入其他集数内容。",
      "【用户配置优先级最高】下方是用户导入或保存的分镜提示词配置。镜头语言、景别、运镜、时长、台词绑定、主体控制、环境动态、即梦适配和画面措辞均以该配置为准。若它与内置导演风格有差异，优先执行用户配置。",
      "【输出协议】用户配置中的“固定输出格式”用于定义每组、每镜必须表达的内容和语言顺序；为接入导演台数据结构，请把这些内容完整映射到指定 JSON 字段。最终只返回可解析 JSON，不得返回 Markdown、代码块、解释或 JSON 之外的文字。",
      "",
      "【用户导入的分镜提示词配置】",
      configurableRules,
      "",
      "【导演台结构约束】",
      "1. 本次" + segmentNote + "生成 " + groupCount + " 个镜头组，组标题从第" + groupStart + "组连续编号。",
      "2. 每组必须 4 至 6 个镜头，每镜 0.5 至 8 秒；每组所有镜头时长合计不得超过 15 秒。",
      "3. 每集总镜头组数控制在 8 至 15 组；不改变原台词，不把台词汇总到组尾。",
      "4. 每个镜头必须给出可直接用于 AI 漫剧画面生成的完整中文分镜提示词。",
      "5. 台词必须逐字保留并绑定到发生该台词的镜头。剧情动作可拆成相邻镜头，但不得删改、概括或合并原台词。",
      "6. 只输出严格 JSON，不要 Markdown 代码块，不要解释。",
      "",
      "【最终输出格式：必须严格匹配】",
      '{"episode":"当前集名","groups":[{"title":"第X组","duration":15,"location":"场景和人物位置","emotion":"本组情绪","shots":[{"shotNo":1,"size":"近景","angle":"平拍","movement":"缓推","duration":3,"visual":"具体画面","dialogue":"原台词，无台词填空字符串","lighting":"光影","effects":"环境动态/特效","prompt":"完整分镜提示词"}]}]}',
    ].join("\n");
  }

  function shotRewriteSystemPrompt() {
    const configurableRules = configuredStoryboardRules(12000);
    return [
      "你是 AI 漫剧导演级分镜师，本次只改写一个已有镜头。",
      "【用户配置优先级最高】用户导入的分镜配置决定镜头表达、主体控制、环境动态、时长和提示词写法；若与内置风格有差异，以用户配置为准。",
      "【输出协议】只返回一个可解析的 JSON 对象。用户配置中的画面字段和输出内容必须完整映射进 JSON，不得返回 Markdown、代码块、解释或 JSON 之外的任何文字。",
      "必须保留当前镜头的 shotNo 与原台词；原台词一个字都不能改，不得概括、删减或新增。",
      "只允许替换本镜头的景别、角度、运镜、时长、画面、光影、环境动态与最终分镜提示词。",
      "尊重用户对参考图类型、人物、场景与道具的使用意图；若用户要求使用参考图，以图片中的造型和空间关系为视觉依据。",
      "本次输出不得包含 groups 数组，不得返回其他镜头。",
      "",
      "【用户导入的分镜提示词配置】",
      configurableRules,
      "",
      "【最终输出格式：必须严格匹配】",
      '{"shot":{"shotNo":1,"size":"近景","angle":"平拍","movement":"缓推","duration":3,"visual":"具体画面","dialogue":"必须逐字复制原台词","lighting":"光影","effects":"环境动态/特效","prompt":"完整分镜提示词"}}',
    ].join("\n");
  }

  function allocateGroupCount(scriptLength) {
    return clamp(MIN_GROUPS + Math.floor(scriptLength / 7000), MIN_GROUPS, MAX_GROUPS);
  }

  function splitScriptForModel(script, chunks) {
    if (chunks <= 1) return [script];
    const lines = String(script || "").split(/\r?\n/);
    const size = Math.ceil(lines.length / chunks);
    const result = [];
    for (let index = 0; index < lines.length; index += size) {
      result.push(lines.slice(index, index + size).join("\n"));
    }
    return result;
  }

  function normalizeStoryboardData(data) {
    const rawGroups = Array.isArray(data) ? data : data.groups || data.storyboard || data.shot_groups;
    if (!Array.isArray(rawGroups) || !rawGroups.length) throw new Error("模型没有返回镜头组。");
    return rawGroups.map((raw, groupIndex) => {
      const rawShots = Array.isArray(raw) ? raw : raw.shots || raw.shot_list || raw.lenses || [];
      const shots = (Array.isArray(rawShots) ? rawShots : []).map((source, shotIndex) => {
        const shot = source && typeof source === "object" ? source : { visual: String(source || "") };
        const duration = clamp(numberValue(shot.duration || shot.seconds || shot.time, 3), 0.5, 15);
        const dialogueValue = shot.dialogue == null ? shot.line : shot.dialogue;
        const dialogue = Array.isArray(dialogueValue)
          ? dialogueValue.map((line) => typeof line === "string" ? line : (line.text || line.content || "")).filter(Boolean).join("\n")
          : String(dialogueValue || "");
        const visual = String(shot.visual || shot.description || shot.content || shot.action || shot.image || "");
        const normalized = {
          id: uid("shot"),
          shotNo: shotIndex + 1,
          size: String(shot.size || shot.shot_size || shot["景别"] || "中景"),
          angle: String(shot.angle || shot.camera_angle || "平拍"),
          movement: String(shot.movement || shot.camera || shot["运镜"] || "固定"),
          duration,
          visual,
          dialogue,
          lighting: String(shot.lighting || shot.light || "自然光，明暗层次克制"),
          effects: String(shot.effects || shot.environment || "无明显特效，保持画面干净"),
          prompt: String(shot.prompt || shot.final_prompt || shot.image_prompt || ""),
          idea: "",
          references: [],
        };
        if (!normalized.prompt) normalized.prompt = composeShotPrompt(normalized, raw, groupIndex);
        return normalized;
      });
      if (!shots.length) return null;
      const rawTotal = totalDuration(shots);
      if (rawTotal > MAX_GROUP_SECONDS) {
        const factor = MAX_GROUP_SECONDS / rawTotal;
        shots.forEach((shot) => {
          shot.duration = Math.max(0.5, Math.floor(shot.duration * factor * 2) / 2);
        });
        let adjusted = totalDuration(shots);
        while (adjusted > MAX_GROUP_SECONDS && shots.length) {
          const idx = shots.reduce((best, shot, index) => shot.duration > shots[best].duration ? index : best, 0);
          if (shots[idx].duration <= 0.5) break;
          shots[idx].duration = Math.round((shots[idx].duration - 0.25) * 2) / 2;
          adjusted = totalDuration(shots);
        }
      }
      return {
        id: uid("group"),
        title: String(!Array.isArray(raw) && (raw.title || raw.group_title) || ("第" + (groupIndex + 1) + "组")),
        duration: totalDuration(shots),
        location: String(!Array.isArray(raw) && (raw.location || raw.scene || raw.position) || ""),
        emotion: String(!Array.isArray(raw) && (raw.emotion || raw.emotional_focus) || ""),
        shots,
      };
    }).filter(Boolean);
  }

  function composeShotPrompt(shot, group, groupIndex) {
    const format = state.project.format === "vertical" ? "9:16 竖屏竖构图" : "16:9 横屏宽银幕构图";
    const location = group && !Array.isArray(group) ? (group.location || group.scene || "") : "";
    const parts = [
      "电影级 AI 漫剧画面，" + format,
      shot.size + "，" + shot.angle + "，" + shot.movement,
      location ? "场景：" + location : "",
      shot.visual,
      shot.lighting,
      shot.effects,
      "角色表演清晰，构图稳定，画面叙事完整，无字幕无水印",
    ];
    return parts.filter(Boolean).join("；") + "。";
  }

  function renumberGroups(groups) {
    return groups.map((group, groupIndex) => {
      group.title = "第" + (groupIndex + 1) + "组";
      group.duration = totalDuration(group.shots);
      group.shots.forEach((shot, shotIndex) => {
        shot.shotNo = shotIndex + 1;
        if (!shot.prompt) shot.prompt = composeShotPrompt(shot, group, groupIndex);
      });
      return group;
    });
  }

  function validateEpisodeGroups(groups, episode) {
    const notes = [];
    if (groups.length < MIN_GROUPS || groups.length > MAX_GROUPS) notes.push("组数 " + groups.length + "（目标 8–15）");
    if (groups.some((group) => group.shots.length < MIN_SHOTS || group.shots.length > MAX_SHOTS)) notes.push("部分组镜数不在 4–6");
    if (groups.some((group) => totalDuration(group.shots) > MAX_GROUP_SECONDS + 0.01)) notes.push("部分组超过 15 秒");
    if (groups.some((group) => group.shots.some((shot) => !shot.visual.trim() || !shot.prompt.trim()))) notes.push("存在画面或最终提示词为空的镜头");
    const prompts = groups.flatMap((group) => group.shots.map((shot) => shot.prompt.trim()).filter(Boolean));
    if (new Set(prompts).size !== prompts.length) notes.push("存在重复的分镜提示词");
    if (episode) {
      const generatedDialogue = dialogueSequence(groups);
      const sourceLines = String(episode.script || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^[^：:\n]{1,24}[：:]\s*\S+/.test(line));
      if (sourceLines.length && !dialogueSequenceEqual(generatedDialogue, sourceLines)) {
        notes.push("台词顺序或完整性与原剧本不一致");
      }
    }
    return notes.join("；");
  }

  function dialogueSequence(groups) {
    return groups.flatMap((group) => group.shots.flatMap((shot) =>
      String(shot.dialogue || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    ));
  }

  function dialogueSequenceEqual(left, right) {
    return left.length === right.length && left.every((line, index) => line === right[index]);
  }

  async function repairStoryboardStructure(episode, data, provider, signal, progress) {
    const originalGroups = renumberGroups(normalizeStoryboardData(data));
    const issue = validateEpisodeGroups(originalGroups);
    const serialized = JSON.stringify({ episode: episode.name, groups: originalGroups });
    if (!issue || serialized.length > 32000) return { data, repaired: false, issue };

    progress("镜头已编排，正在修正组数与镜数");
    try {
      const raw = await requestModel(provider, {
        messages: [
          { role: "system", content: directorSystemPrompt(1, Math.max(MIN_GROUPS, Math.min(MAX_GROUPS, originalGroups.length)), "结构修复") },
          {
            role: "user",
            content: [
              "下面是同一集的分镜 JSON，结构检查结果：" + issue,
              "只做结构修复：每集调整为 8–15 组，每组调整到 4–6 个镜头，每组总时长不超过 15 秒。",
              "优先拆分或合并相邻镜头来修正，不得改动、删除、缩写或迁移任何原台词。保持集数边界，不得引入其他集内容。",
              "保持已有画面、光影、特效和完整提示词，只返回修复后的完整 JSON。",
              serialized,
            ].join("\n"),
          },
        ],
        maxTokens: provider.max_tokens,
        temperature: 0.2,
        signal,
        timeoutMs: 180000,
      });
      const candidate = renumberGroups(normalizeStoryboardData(extractJson(raw)));
      const candidateIssue = validateEpisodeGroups(candidate);
      const dialoguePreserved = dialogueSequenceEqual(
        dialogueSequence(candidate),
        dialogueSequence(originalGroups)
      );
      if (!candidateIssue && dialoguePreserved) {
        return { data: { episode: episode.name, groups: candidate }, repaired: true, issue: "" };
      }
    } catch (_error) {
      // Keep the original valid content and expose the structure warning instead of losing dialogue.
    }
    return { data, repaired: false, issue };
  }

  function episodeReferenceImages(episode, limit) {
    const seen = new Set();
    const references = [];
    (episode.groups || []).forEach((group) => {
      (group.shots || []).forEach((shot) => {
        (shot.references || []).forEach((reference) => {
          const key = reference.id || reference.dataUrl;
          if (!key || seen.has(key) || !reference.dataUrl) return;
          seen.add(key);
          references.push(reference);
        });
      });
    });
    return references.slice(0, limit || 8);
  }

  async function requestStoryboardForEpisode(episode, provider, providerId, signal, progress, config) {
    if (providerId === "demo") {
      await sleep(650);
      progress("正在用本地演示编排镜头");
      return {
        episode: episode.name,
        groups: mockStoryboardGroups(episode),
      };
    }
    const desiredGroups = allocateGroupCount(episode.script.length);
    const shouldChunk = episode.script.length > 26000;
    const chunkCount = shouldChunk ? Math.min(4, Math.ceil(episode.script.length / 18000)) : 1;
    const chunks = splitScriptForModel(episode.script, chunkCount);
    const allGroups = [];
    const references = episodeReferenceImages(episode, 8);
    const referenceType = { character: "人物", scene: "场景", prop: "道具" };
    const referenceManifest = references.length
      ? references.map((reference, index) =>
          "图" + (index + 1) + "=" + (referenceType[reference.type] || "参考") + ":" + reference.name
        ).join("；")
      : "无";

    for (let index = 0; index < chunks.length; index += 1) {
      const remainingChunks = chunks.length - index;
      const groupsLeft = Math.max(1, desiredGroups - allGroups.length);
      const count = remainingChunks === 1
        ? groupsLeft
        : clamp(
            Math.round(groupsLeft / remainingChunks),
            1,
            Math.max(1, groupsLeft - (remainingChunks - 1))
          );
      const start = allGroups.length + 1;
      progress("第 " + (index + 1) + " / " + chunks.length + " 段 · 编排 " + count + " 组");
      const userText = [
        "当前集：" + episode.name,
        "制作画幅：" + (state.project.format === "vertical" ? "9:16 竖屏" : "16:9 横屏"),
        shouldChunk ? "这是本集的第 " + (index + 1) + " / " + chunks.length + " 段。只写本段内容，不要补写其他段，不要混入其他集。" : "以下是本集完整剧本。",
        "",
        "【必须执行：用户导入的分镜提示词配置｜优先级高于内置风格】",
        configuredStoryboardRules(12000),
        "【配置结束】",
        "",
        "【本集视觉参考】",
        referenceManifest,
        references.length
          ? "参考边界：场景图只控制空间、建筑、陈设、时间与光线；人物图只控制脸型、发型、服装与造型；道具图只控制轮廓、材质与细节。不得让某类参考越界控制其他内容。"
          : "本集没有关联参考图，按文字剧本生成。",
        references.length && config && config.vision
          ? "附图已随请求发送。每个镜头的最终提示词必须具体体现对应参考图中可观察的视觉特征，不能只写“参考图片”。"
          : "当前未开启视觉模型图片发送；图片只作为本集资产关联信息。",
        "",
        "剧本内容：",
        chunks[index],
      ].join("\n");
      const userContent = references.length && config && config.vision
        ? [
            { type: "text", text: userText },
            ...references.map((reference) => ({
              type: "image_url",
              image_url: { url: reference.dataUrl },
            })),
          ]
        : userText;
      const raw = await requestModel(provider, {
        messages: [
          { role: "system", content: directorSystemPrompt(start, count, shouldChunk ? "本段" : "本集") },
          { role: "user", content: userContent },
        ],
        maxTokens: providerId === "demo" ? 4000 : provider.max_tokens,
        temperature: 0.72,
        signal,
        timeoutMs: 240000,
      });
      let data;
      try {
        data = extractJson(raw);
      } catch (error) {
        throw new Error(error.message + " 请检查分镜规则是否强制模型输出了非 JSON 文本。");
      }
      const normalized = normalizeStoryboardData(data);
      allGroups.push(...normalized);
    }
    const assembled = { episode: episode.name, groups: renumberGroups(allGroups) };
    const repaired = await repairStoryboardStructure(episode, assembled, provider, signal, progress);
    return repaired.data;
  }

  function mockStoryboardGroups(episode) {
    const sceneList = sceneHeaders(episode.script);
    const lines = episode.script.split(/\r?\n/).map((line) => line.trim()).filter((line) =>
      line && !episodeHeading(line) && !/^\d{1,3}\s*[-－—]\s*\d{1,3}/.test(line)
    );
    const dialogueLines = lines.filter((line) => /^[^：:\n]{1,16}[：:]\s*\S+/.test(line));
    const visualLines = lines.filter((line) => !/^[^：:\n]{1,16}[：:]\s*\S+/.test(line));
    const groups = [];
    for (let groupIndex = 0; groupIndex < 8; groupIndex += 1) {
      const scene = sceneList[groupIndex % Math.max(1, sceneList.length)] || { name: "本集主场景", period: "日", place: "内" };
      const baseVisual = visualLines[groupIndex] || lines[groupIndex] || "人物在场景中完成本段剧情动作，镜头保持清晰的主体关系。";
      const dialogueStart = Math.floor((dialogueLines.length * groupIndex) / 8);
      const dialogueEnd = Math.floor((dialogueLines.length * (groupIndex + 1)) / 8);
      const groupDialogue = dialogueLines.slice(dialogueStart, dialogueEnd);
      const shots = [];
      for (let shotIndex = 0; shotIndex < 4; shotIndex += 1) {
        const sizes = ["中景", "近景", "特写", "中近景"];
        const movements = ["固定", "缓推", "横移", "轻微跟拍"];
        const visual = shotIndex === 0
          ? baseVisual
          : (visualLines[groupIndex * 4 + shotIndex] || "延续上一镜的动作与视线，人物状态发生细微变化，空间关系保持连续。");
        const shotDialogueStart = Math.floor((groupDialogue.length * shotIndex) / 4);
        const shotDialogueEnd = Math.floor((groupDialogue.length * (shotIndex + 1)) / 4);
        const shot = {
          id: uid("shot"),
          shotNo: shotIndex + 1,
          size: sizes[shotIndex],
          angle: shotIndex % 2 ? "侧面平拍" : "正面平拍",
          movement: movements[shotIndex],
          duration: 2.5,
          visual,
          dialogue: groupDialogue.slice(shotDialogueStart, shotDialogueEnd).join("\n"),
          lighting: groupIndex % 2 ? "侧逆光，明暗层次克制" : "柔和自然光，人物轮廓清楚",
          effects: "无明显特效，以人物表演、视线与衣摆动态承接氛围",
          prompt: "",
          idea: "",
          references: [],
        };
        shot.prompt = composeShotPrompt(shot, {
          location: (scene.period || "") + (scene.place || "") + " " + scene.name,
        }, groupIndex);
        shots.push(shot);
      }
      groups.push({
        id: uid("group"),
        title: "第" + (groupIndex + 1) + "组",
        duration: 10,
        location: (scene.period || "") + (scene.place || "") + " " + scene.name,
        emotion: ["试探", "压迫", "克制", "转折"][groupIndex % 4],
        shots,
      });
    }
    return groups;
  }

  async function generateEpisode(episode, run) {
    const { config, providerId, provider } = getRuntimeProvider();
    if (providerId !== "demo" && (!provider.base_url || !provider.api_key || !provider.model)) {
      throw new Error("模型尚未配置完整。请先打开“模型”填写 API 地址、Key 与模型名。");
    }
    episode.status = "generating";
    episode.error = "";
    renderEpisodeList();
    renderCurrentEpisode();
    const controller = new AbortController();
    run.controllers.set(episode.id, controller);
    const progress = (message) => {
      const index = run.episodes.indexOf(episode);
      run.ticks = (run.ticks || 0) + 1;
      updateGenerationProgress(episode.name + " · " + message, run.completed, run.total, run.ticks);
      if (index === -1) return;
    };
    try {
      const data = await requestStoryboardForEpisode(episode, {
        ...provider,
        max_tokens: config.max_tokens,
      }, providerId, controller.signal, progress, config);
      if (run.cancelled) throw new DOMException("已取消", "AbortError");
      const groups = renumberGroups(normalizeStoryboardData(data));
      if (!groups.length) throw new Error("模型未生成有效镜头组。");
      episode.groups = groups;
      episode.validation = validateEpisodeGroups(groups, episode);
      episode.status = "generated";
      episode.updatedAt = new Date().toISOString();
      episode.error = episode.validation ? "提示：" + episode.validation : "";
      return true;
    } catch (error) {
      if (error && error.name === "AbortError") {
        episode.status = episode.groups.length ? "generated" : "ready";
        episode.error = "";
        throw error;
      }
      episode.status = "failed";
      episode.error = modelErrorMessage(error);
      return false;
    } finally {
      run.controllers.delete(episode.id);
      saveProject(true);
      renderWorkspace();
    }
  }

  async function generateEpisodes(episodeIds) {
    if (generationRun) {
      showToast("已有生成任务正在运行。", true);
      return;
    }
    const episodes = state.episodes.filter((episode) => episodeIds.includes(episode.id));
    if (!episodes.length) {
      showToast("请先勾选至少一集，或打开一集后点击“生成当前集”。", true);
      return;
    }
    const { providerId, provider } = getRuntimeProvider();
    if (providerId !== "demo" && (!provider.base_url || !provider.api_key || !provider.model)) {
      openModelModal();
      showToast("请先完成模型配置，或在模型面板选择演示模式。", true);
      return;
    }
    const replacing = episodes.filter((episode) => episode.groups.length);
    if (replacing.length && !window.confirm("所选集数中有 " + replacing.length + " 集已有分镜。继续生成会替换这些集，是否继续？")) return;

    const run = {
      token: uid("run"),
      episodes,
      queue: episodes.map((episode) => episode.id),
      controllers: new Map(),
      cancelled: false,
      completed: 0,
      total: episodes.length,
      failed: 0,
      percent: 4,
      stage: "准备拆分镜头",
      summary: "",
    };
    generationRun = run;
    document.body.classList.add("is-generating");
    $("#generationOverlay").hidden = false;
    $("#generationOverlayTitle").textContent = "开始编排 " + episodes.length + " 集";
    $("#generationOverlayMeta").textContent = "每集独立请求，最多同时处理 2 集";
    $("#generationOverlayPercent").textContent = "0%";
    $("#generationOverlayStage").textContent = "锁定集数边界与用户分镜配置";
    renderGenerationState();

    const worker = async () => {
      while (run.queue.length && !run.cancelled) {
        const id = run.queue.shift();
        const episode = state.episodes.find((item) => item.id === id);
        if (!episode) continue;
        try {
          const ok = await generateEpisode(episode, run);
          if (!ok) run.failed += 1;
        } catch (error) {
          if (error && error.name === "AbortError") return;
          episode.status = "failed";
          episode.error = modelErrorMessage(error);
          run.failed += 1;
        }
        run.completed += 1;
        updateGenerationProgress(
          run.cancelled ? "任务已停止" : "完成 " + episode.name,
          run.completed,
          run.total
        );
      }
    };

    try {
      await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_EPISODES, episodes.length) }, worker));
      run.summary = run.cancelled
        ? "已停止：完成 " + run.completed + " / " + run.total + " 集"
        : "本次完成 " + (run.total - run.failed) + " 集" + (run.failed ? "，" + run.failed + " 集失败，可单集重试" : "");
    } catch (error) {
      run.summary = "生成中断：" + modelErrorMessage(error);
      run.failed += 1;
    } finally {
      $("#generationOverlay").hidden = true;
      $("#generationOverlayTitle").textContent = "编排完成";
      $("#generationOverlayMeta").textContent = run.summary;
      document.body.classList.remove("is-generating");
      generationRun = null;
      const firstGenerated = episodes.find((episode) => episode.status === "generated");
      if (firstGenerated) {
        state.activeEpisodeId = firstGenerated.id;
        activeGroupIndex = 0;
        activeShotId = firstGenerated.groups[0] && firstGenerated.groups[0].shots[0] ? firstGenerated.groups[0].shots[0].id : "";
      }
      saveProject(true);
      renderWorkspace();
      if (window.innerWidth <= 720 && firstGenerated) setMobileView("groups");
    }
    showToast(run.summary, run.failed > 0);
  }

  function cancelGeneration() {
    if (!generationRun) return;
    generationRun.cancelled = true;
    generationRun.queue = [];
    generationRun.controllers.forEach((controller) => controller.abort());
    generationRun.summary = "正在停止任务…";
    $("#generationOverlayTitle").textContent = "正在停止";
    $("#generationOverlayMeta").textContent = "已中止进行中的模型请求";
    renderGenerationState();
  }

  function defaultNewShot(index) {
    const shot = {
      id: uid("shot"),
      shotNo: index + 1,
      size: "中景",
      angle: "平拍",
      movement: "固定",
      duration: 2.5,
      visual: "",
      dialogue: "",
      lighting: "自然光，明暗层次清晰",
      effects: "无明显特效，保持画面干净",
      prompt: "",
      idea: "",
      references: [],
    };
    shot.prompt = composeShotPrompt(shot, getActiveGroup(), activeGroupIndex);
    return shot;
  }

  function addShot() {
    const group = getActiveGroup();
    if (!group) return;
    const shot = defaultNewShot(group.shots.length);
    group.shots.push(shot);
    activeShotId = shot.id;
    group.duration = totalDuration(group.shots);
    saveProject();
    renderGroup();
    renderCurrentEpisode();
    $("#visual, [name=visual]").focus();
  }

  function addGroup() {
    const episode = getEpisode();
    if (!episode) return;
    const shots = Array.from({ length: 4 }, (_, index) => defaultNewShot(index));
    const group = {
      id: uid("group"),
      title: "第" + (episode.groups.length + 1) + "组",
      duration: totalDuration(shots),
      location: "",
      emotion: "",
      shots,
    };
    episode.groups.push(group);
    activeGroupIndex = episode.groups.length - 1;
    activeShotId = shots[0].id;
    episode.status = "generated";
    saveProject();
    renderWorkspace();
  }

  function deleteCurrentGroup() {
    const episode = getEpisode();
    const group = getActiveGroup();
    if (!episode || !group) return;
    if (!window.confirm("删除“" + group.title + "”及组内全部镜头？")) return;
    episode.groups.splice(activeGroupIndex, 1);
    activeGroupIndex = clamp(activeGroupIndex, 0, Math.max(0, episode.groups.length - 1));
    activeShotId = episode.groups[activeGroupIndex] && episode.groups[activeGroupIndex].shots[0] ? episode.groups[activeGroupIndex].shots[0].id : "";
    if (!episode.groups.length) episode.status = "ready";
    saveProject(true);
    renderWorkspace();
  }

  function deleteCurrentShot() {
    const group = getActiveGroup();
    const shot = getActiveShot();
    if (!group || !shot) return;
    const index = group.shots.findIndex((item) => item.id === shot.id);
    if (index === -1) return;
    group.shots.splice(index, 1);
    group.shots.forEach((item, shotIndex) => { item.shotNo = shotIndex + 1; });
    activeShotId = group.shots[Math.min(index, group.shots.length - 1)] ? group.shots[Math.min(index, group.shots.length - 1)].id : "";
    group.duration = totalDuration(group.shots);
    saveProject();
    renderGroup();
    renderCurrentEpisode();
  }

  function duplicateGroup() {
    const group = getActiveGroup();
    const episode = getEpisode();
    if (!group || !episode) return;
    const clone = JSON.parse(JSON.stringify(group));
    clone.id = uid("group");
    clone.title = "第" + (episode.groups.length + 1) + "组";
    clone.shots.forEach((shot) => { shot.id = uid("shot"); });
    episode.groups.push(clone);
    activeGroupIndex = episode.groups.length - 1;
    activeShotId = clone.shots[0] ? clone.shots[0].id : "";
    saveProject();
    renderWorkspace();
  }

  function formatGroupPromptText(group, episode) {
    const referenceType = { character: "人物", scene: "场景", prop: "道具" };
    const format = state.project.format === "vertical" ? "9:16 竖屏" : "16:9 横屏";
    const seenReferences = new Set();
    const references = group.shots.flatMap((shot) => shot.references || []).filter((reference) => {
      const key = reference.id || reference.dataUrl;
      if (!key || seenReferences.has(key)) return false;
      seenReferences.add(key);
      return true;
    });
    const referenceText = references.length
      ? references.map((reference, index) =>
          "图" + (index + 1) + "｜" + (referenceType[reference.type] || "参考") + "｜" + reference.name + (reference.note ? "｜" + reference.note : "")
        ).join("\n")
      : "无";
    const shotText = group.shots.map((shot, index) => [
      "镜头 " + String(index + 1).padStart(2, "0"),
      "景别：" + (shot.size || "未填写") + "｜角度：" + (shot.angle || "未填写") + "｜运镜：" + (shot.movement || "未填写") + "｜时长：" + shot.duration + "秒",
      "画面：" + (shot.visual || "未填写"),
      "台词：" + (shot.dialogue || "无台词"),
      "光影：" + (shot.lighting || "未填写"),
      "特效/环境动态：" + (shot.effects || "无明显特效"),
      "最终提示词：" + (shot.prompt || "未填写"),
    ].join("\n")).join("\n\n");
    return [
      "AI 漫剧分镜提示词",
      "项目：" + (state.project.name || "未命名项目"),
      "集数：" + (episode ? episode.name : "未选择"),
      "镜头组：" + group.title,
      "画幅：" + format,
      "位置状态与场景：" + (group.location || "未填写"),
      "本组情绪重点：" + (group.emotion || "未填写"),
      "本组总时长：" + totalDuration(group.shots).toFixed(1).replace(/\.0$/, "") + "秒",
      "",
      "【整组镜头】",
      shotText,
      "",
      "【本组参考资产】",
      referenceText,
      references.length ? "使用边界：场景只锁空间与光线，人物只锁造型与服装，道具只锁轮廓、材质和细节；不得越界添加未要求的主体。" : "",
      "",
      "【整组连续性要求】",
      "保持人物造型、服装、空间方向、视线关系、动作起止与光影连续；镜头之间使用自然剪辑衔接，不改变原台词。",
    ].join("\n");
  }

  async function copyPlainText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (!copied) throw new Error("浏览器未允许写入剪贴板。");
  }

  async function copyCurrentGroupPrompt() {
    const group = getActiveGroup();
    const episode = getEpisode();
    if (!group) return;
    const buttons = $$("[data-copy-group]");
    const originals = buttons.map((button) => button.innerHTML);
    try {
      await copyPlainText(formatGroupPromptText(group, episode));
      buttons.forEach((button) => {
        button.classList.add("copied");
        button.innerHTML = '<svg><use href="#i-scan"></use></svg>已复制本组提示词';
      });
      window.setTimeout(() => {
        buttons.forEach((button, index) => {
          button.classList.remove("copied");
          button.innerHTML = originals[index];
        });
      }, 1800);
      showToast("已复制“" + group.title + "”的整组分镜提示词，可直接粘贴到外部工具。");
    } catch (error) {
      showToast(error.message || "复制失败，请检查浏览器剪贴板权限。", true);
    }
  }

  function duplicateEpisode() {
    const episode = getEpisode();
    if (!episode) return;
    const clone = JSON.parse(JSON.stringify(episode));
    clone.id = uid("episode");
    clone.name = episode.name + "（副本）";
    clone.order = state.episodes.length + 1;
    clone.groups.forEach((group) => {
      group.id = uid("group");
      group.shots.forEach((shot) => { shot.id = uid("shot"); });
    });
    state.episodes.push(clone);
    state.activeEpisodeId = clone.id;
    activeGroupIndex = 0;
    activeShotId = clone.groups[0] && clone.groups[0].shots[0] ? clone.groups[0].shots[0].id : "";
    saveProject(true);
    renderWorkspace();
    showToast("已复制本集，副本保留全部镜头，可独立修改。");
  }

  function moveActiveGroup(direction) {
    const episode = getEpisode();
    const next = activeGroupIndex + direction;
    if (!episode || next < 0 || next >= episode.groups.length) return;
    const temp = episode.groups[next];
    episode.groups[next] = episode.groups[activeGroupIndex];
    episode.groups[activeGroupIndex] = temp;
    activeGroupIndex = next;
    renumberGroups(episode.groups);
    saveProject();
    renderWorkspace();
  }

  function renderShotFormValues() {
    const shot = getActiveShot();
    if (!shot) return;
    const form = $("#shotForm");
    ["size", "angle", "movement", "duration", "visual", "dialogue", "lighting", "effects", "prompt"].forEach((name) => {
      if (form.elements[name]) shot[name] = name === "duration" ? clamp(numberValue(form.elements[name].value, 2.5), 0.5, 20) : form.elements[name].value;
    });
    shot.idea = $("#shotIdea").value;
    const group = getActiveGroup();
    group.duration = totalDuration(group.shots);
    saveProject();
  }

  async function compressReference(file) {
    if (!file.type.startsWith("image/")) throw new Error("请选择图片文件。");
    if (file.size > 12 * 1024 * 1024) throw new Error("参考图不能超过 12MB。");
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("图片读取失败。"));
      reader.readAsDataURL(file);
    });
    const image = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("图片无法解析。"));
      img.src = dataUrl;
    });
    const maxSide = 960;
    const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.72);
  }

  async function addReferenceFiles(files) {
    const shot = getActiveShot();
    if (!shot) return;
    const available = 4 - shot.references.length;
    if (available <= 0) {
      showToast("每个镜头最多保存 4 张参考图。", true);
      return;
    }
    const selectedFiles = Array.from(files || []).slice(0, available);
    $("#shotSaveStatus").textContent = "正在处理参考图…";
    for (const file of selectedFiles) {
      try {
        const dataUrl = await compressReference(file);
        shot.references.push({
          id: uid("reference"),
          name: file.name.replace(/\.[^.]+$/, "").slice(0, 32) || "参考图",
          type: currentReferenceType,
          dataUrl,
          note: "",
        });
      } catch (error) {
        showToast(error.message, true);
      }
    }
    $("#shotSaveStatus").textContent = "修改自动保存";
    saveProject(true);
    renderReferences(shot);
    renderGroup();
  }

  function removeReference(referenceId) {
    const shot = getActiveShot();
    if (!shot) return;
    shot.references = shot.references.filter((reference) => reference.id !== referenceId);
    saveProject(true);
    renderReferences(shot);
    renderGroup();
  }

  function buildRewriteUserContent(shot, idea, includeImages, mode) {
    const episode = getEpisode();
    const group = getActiveGroup();
    const context = {
      episode: episode.name,
      group: group.title,
      groupLocation: group.location,
      groupEmotion: group.emotion,
      currentShot: {
        shotNo: shot.shotNo,
        size: shot.size,
        angle: shot.angle,
        movement: shot.movement,
        duration: shot.duration,
        visual: shot.visual,
        dialogue: shot.dialogue,
        lighting: shot.lighting,
        effects: shot.effects,
        prompt: shot.prompt,
      },
      directorIdea: idea,
      rewriteMode: mode === "references" ? "依据参考图重生成当前镜头" : "依据导演修改想法重写当前镜头",
      references: shot.references.map((reference, index) => ({
        imageNo: index + 1,
        type: reference.type,
        name: reference.name,
        note: reference.note || "",
      })),
    };
    const text = [
      "只改写并返回一个镜头，不要动其他镜头。",
      "严格保留原台词，不得修改。",
      (mode === "references"
        ? "请以所附参考图为视觉依据，重新设计当前镜头；保留未被要求修改的叙事信息。"
        : "请按导演修改想法重新设计当前镜头；保留未被要求修改的叙事信息。"),
      "附件图片与文本的对应顺序：" + (shot.references.map((reference, index) =>
        "图" + (index + 1) + "=" + ({ character: "人物", scene: "场景", prop: "道具" })[reference.type] + ":" + reference.name
      ).join("；") || "无"),
      "参考图使用边界：场景图只用于空间结构、建筑、陈设、时间与光线氛围；人物图只用于角色脸型、发型、服装与造型；道具图只用于材质、轮廓与细节。不要因为某张参考图而引入未要求的其他主体。",
      "如果附带了参考图，最终画面和最终分镜提示词必须明确体现参考图中的视觉特征，而不是只在说明中提到参考过图片。",
      "当前上下文：" + JSON.stringify(context),
      "请输出 JSON：{\"shot\":{\"shotNo\":1,\"size\":\"\",\"angle\":\"\",\"movement\":\"\",\"duration\":3,\"visual\":\"\",\"dialogue\":\"\",\"lighting\":\"\",\"effects\":\"\",\"prompt\":\"完整分镜提示词\"}}",
    ].join("\n");
    if (!includeImages || !shot.references.length) return text;
    return [
      { type: "text", text },
      ...shot.references.map((reference) => ({
        type: "image_url",
        image_url: { url: reference.dataUrl },
      })),
    ];
  }

  async function rewriteCurrentShot(mode) {
    const shot = getActiveShot();
    if (!shot || rewriteController) return;
    const idea = $("#shotIdea").value.trim();
    if (mode === "idea" && !idea) {
      showToast("请先写下你对这个镜头的修改想法。", true);
      $("#shotIdea").focus();
      return;
    }
    if (mode === "references" && !shot.references.length) {
      showToast("当前镜头还没有参考图，请先添加人物、场景或道具参考图。", true);
      $("#addReference").focus();
      return;
    }
    if (idea) shot.idea = idea;
    const { config, providerId, provider } = getRuntimeProvider();
    if (providerId !== "demo" && (!provider.base_url || !provider.api_key || !provider.model)) {
      openModelModal();
      showToast("请先完成模型配置。", true);
      return;
    }
    const button = $("#" + (mode === "references" ? "regenerateWithReferences" : "rewriteShot"));
    rewriteController = new AbortController();
    button.disabled = true;
    document.body.classList.add("is-generating");
    $("#generationOverlay").hidden = false;
    $("#generationOverlayTitle").textContent = mode === "references" ? "正在读取参考图" : "正在重写当前镜头";
    $("#generationOverlayMeta").textContent = mode === "references"
      ? "锁定原台词，依据人物、场景与道具参考图重构这一镜"
      : "保留台词与环境连续性，只替换这一镜";
    $("#generationOverlayPercent").textContent = "18%";
    $("#generationOverlayProgress").style.width = "18%";
    $("#generationOverlayStage").textContent = mode === "references" ? "分析场景结构与角色造型" : "读取导演修改意图";
    $("#shotSaveStatus").textContent = mode === "references" ? "正在按参考图重生成…" : "正在重写…";
    try {
      let result;
      if (providerId === "demo") {
        await sleep(950);
        const referenceSummary = shot.references.map((reference) => reference.type + ":" + reference.name).join("、");
        result = {
          shotNo: shot.shotNo,
          size: idea.includes("特写") ? "特写" : (mode === "references" ? "近景" : shot.size),
          angle: idea.includes("俯拍") ? "俯拍" : (mode === "references" ? "侧面平拍" : shot.angle),
          movement: idea.includes("推") ? "缓推" : (mode === "references" ? "轻微跟拍" : shot.movement),
          duration: clamp(shot.duration, 2, 6),
          visual: mode === "references"
            ? "依据参考图 " + referenceSummary + " 重构当前画面，保持人物造型、空间关系与叙事连续性。"
            : idea + "。画面遵循导演修改想法，人物状态与环境关系保持连贯。",
          dialogue: shot.dialogue,
          lighting: shot.lighting || "侧光勾勒人物轮廓，明暗层次克制",
          effects: shot.effects || "环境细微动态，无多余特效",
          prompt: "",
        };
      } else {
        const system = shotRewriteSystemPrompt();
        const content = buildRewriteUserContent(shot, idea, Boolean(config.vision), mode);
        const raw = await requestModel(provider, {
          messages: [
            { role: "system", content: system },
            { role: "user", content },
          ],
          maxTokens: Math.min(config.max_tokens || 4096, 4096),
          temperature: 0.82,
          signal: rewriteController.signal,
          timeoutMs: 120000,
        });
        const parsed = extractJson(raw);
        result = parsed.shot || (Array.isArray(parsed.shots) ? parsed.shots[0] : parsed);
      }
      const merged = normalizeShot({ ...shot, ...result, id: shot.id, duration: clamp(numberValue(result.duration, shot.duration), 0.5, 20) }, shot.shotNo - 1);
      merged.id = shot.id;
      merged.shotNo = shot.shotNo;
      merged.dialogue = shot.dialogue;
      merged.idea = idea || shot.idea;
      merged.references = shot.references;
      if (!merged.prompt || merged.prompt === shot.prompt) merged.prompt = composeShotPrompt(merged, getActiveGroup(), activeGroupIndex);
      const group = getActiveGroup();
      const index = group.shots.findIndex((item) => item.id === shot.id);
      group.shots[index] = merged;
      group.duration = totalDuration(group.shots);
      activeShotId = merged.id;
      saveProject(true);
      renderGroup();
      renderCurrentEpisode();
      showToast(mode === "references" ? "当前镜头已按参考图重生成，原台词与其他镜头未改动。" : "当前镜头已按你的想法重写，其他镜头未改动。");
    } catch (error) {
      $("#shotSaveStatus").textContent = "重写失败";
      showToast(modelErrorMessage(error), true);
    } finally {
      rewriteController = null;
      button.disabled = false;
      document.body.classList.remove("is-generating");
      $("#generationOverlay").hidden = true;
      $("#shotSaveStatus").textContent = "修改自动保存";
    }
  }

  function saveRules() {
    state.rules = $("#rulesInput").value.trim() || P.rules || "";
    localStorage.setItem(RULES_KEY, state.rules);
    saveProject(true);
    closeModal("rulesModal");
    showToast("分镜提示词配置已保存，将随下次请求发送。");
  }

  function resetRules() {
    $("#rulesInput").value = P.rules || "";
    $("#rulesFileLabel").textContent = "已恢复默认，尚未保存";
  }

  function exportProject() {
    if (!state.project.script) {
      showToast("还没有可导出的项目。", true);
      return;
    }
    const payload = {
      schemaVersion: 2,
      exportedAt: new Date().toISOString(),
      project: state.project,
      episodes: state.episodes,
      activeEpisodeId: state.activeEpisodeId,
      rules: state.rules,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = (state.project.name || "漫剧导演项目").replace(/[\\/:*?"<>|]/g, "_") + ".json";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast("项目已导出。API Key 未写入导出文件。");
  }

  async function importProject(file) {
    if (!file) return;
    if (file.size > 40 * 1024 * 1024) {
      showToast("项目文件过大，建议先删除部分参考图。", true);
      return;
    }
    try {
      const raw = JSON.parse(await file.text());
      const imported = normalizeState(raw);
      if (!imported.project.script || !imported.episodes.length) throw new Error("文件中缺少剧本或分集数据。");
      state = imported;
      state.rules = typeof raw.rules === "string" ? raw.rules : (P.rules || "");
      selection = new Set();
      activeGroupIndex = 0;
      activeShotId = "";
      saveProject(true);
      showDirector();
      showToast("项目已导入，共 " + state.episodes.length + " 集。");
    } catch (error) {
      showToast("项目导入失败：" + error.message, true);
    } finally {
      $("#projectFile").value = "";
    }
  }

  function bindFileInput(input, handler) {
    input.addEventListener("change", () => {
      const file = input.files && input.files[0];
      if (file) handler(file);
    });
  }

  function reorderByDrag(type, fromIndex, toIndex) {
    if (type === "group") {
      const episode = getEpisode();
      if (!episode || fromIndex === toIndex) return;
      const [item] = episode.groups.splice(fromIndex, 1);
      episode.groups.splice(toIndex, 0, item);
      activeGroupIndex = toIndex;
      renumberGroups(episode.groups);
    } else if (type === "shot") {
      const group = getActiveGroup();
      if (!group || fromIndex === toIndex) return;
      const [item] = group.shots.splice(fromIndex, 1);
      group.shots.splice(toIndex, 0, item);
      group.shots.forEach((shot, index) => { shot.shotNo = index + 1; });
      group.duration = totalDuration(group.shots);
    }
    saveProject();
    renderWorkspace();
  }

  function bindDragEvents() {
    let dragData = null;
    document.addEventListener("dragstart", (event) => {
      const groupTab = event.target.closest(".group-tab");
      const shotCard = event.target.closest(".shot-sheet-row");
      if (groupTab) {
        dragData = { type: "group", index: Number(groupTab.dataset.groupIndex) };
        groupTab.style.opacity = ".5";
      } else if (shotCard) {
        const group = getActiveGroup();
        const index = group ? group.shots.findIndex((shot) => shot.id === shotCard.dataset.shotId) : -1;
        if (index >= 0) {
          dragData = { type: "shot", index };
          shotCard.style.opacity = ".5";
        }
      }
    });
    document.addEventListener("dragend", (event) => {
      const target = event.target.closest(".group-tab, .shot-sheet-row");
      if (target) target.style.opacity = "";
      dragData = null;
    });
    document.addEventListener("dragover", (event) => {
      if (!dragData) return;
      const target = dragData.type === "group" ? event.target.closest(".group-tab") : event.target.closest(".shot-sheet-row");
      if (target) event.preventDefault();
    });
    document.addEventListener("drop", (event) => {
      if (!dragData) return;
      event.preventDefault();
      if (dragData.type === "group") {
        const target = event.target.closest(".group-tab");
        if (target) reorderByDrag("group", dragData.index, Number(target.dataset.groupIndex));
      } else {
        const target = event.target.closest(".shot-sheet-row");
        const group = getActiveGroup();
        if (target && group) {
          const toIndex = group.shots.findIndex((shot) => shot.id === target.dataset.shotId);
          if (toIndex >= 0) reorderByDrag("shot", dragData.index, toIndex);
        }
      }
      dragData = null;
    });
  }

  function bindEvents() {
    $("#themeToggle").addEventListener("click", () => {
      setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
    });
    $("#modelButton").addEventListener("click", openModelModal);
    $("#rulesButton").addEventListener("click", openRulesModal);
    $("#projectMenuButton").addEventListener("click", () => {
      openModelModal();
      showToast("项目设置与模型设置共用此面板。");
    });
    $("#exportProject").addEventListener("click", exportProject);
    $("#brandHome").addEventListener("click", () => showSetup(false));
    $("#newProjectButton").addEventListener("click", () => {
      if (state.episodes.length && !window.confirm("打开新项目入口？当前项目已自动保存在浏览器中。")) return;
      showSetup(true);
      $("#projectNameInput").focus();
    });
    $("#scriptInput").addEventListener("input", () => {
      updateScriptMetrics();
      if (scanDraft && $("#scriptInput").value.trim() !== scanDraft.script) {
        $("#enterWorkspace").disabled = true;
        $("#scriptFileState").textContent = "内容已变化，请重新识别";
      }
    });
    $("#projectNameInput").addEventListener("input", () => {
      if (scanDraft) setScanSummary(scanDraft.episodes, scanDraft.stats, $("#projectNameInput").value.trim());
    });
    $$(".format-option").forEach((option) => option.addEventListener("click", () => setDirection(option.dataset.format)));
    $("#scanScriptButton").addEventListener("click", scanScript);
    $("#enterWorkspace").addEventListener("click", enterWorkspace);
    $("#loadDemoButton").addEventListener("click", () => {
      $("#projectNameInput").value = "长夜入局 · 导演测试项目";
      $("#scriptInput").value = [
        "第1集 夜雨入府",
        "1-1 夜 外 镇北王府门前",
        "雨水顺着青石台阶流下，守卫举灯拦在门前。",
        "沈砚：我只问一句，世子可在府中？",
        "守卫：今夜不见外客。",
        "沈砚没有退，视线越过守卫，落在门缝里的一线灯光上。",
        "",
        "1-2 夜 内 镇北王府前厅",
        "烛火被穿堂风吹得微晃，谢临舟站在屏风前，手中压着一封未拆的信。",
        "谢临舟：让她进来。",
        "门轴轻响，沈砚跨过门槛，雨水从衣角落到地砖上。",
        "",
        "第2集 旧信",
        "2-1 日 内 书房",
        "晨光穿过半开的窗，案上摊着一封泛黄旧信。",
        "谢临舟：这封信，你从哪里得来？",
        "沈砚：从一个已经死了的人手里。",
        "两人隔着书案对视，窗外鸟声忽然停了。",
        "",
        "2-2 日 外 回廊",
        "沈砚沿回廊向前走，身后脚步声不紧不慢地跟着。",
        "她停在转角，没有回头。",
        "沈砚：世子还要跟到什么时候？",
        "",
        "第3集 刀锋",
        "3-1 夜 外 后院竹林",
        "风压低竹叶，月光把两人的影子拉长。",
        "黑衣人从暗处扑出，刀锋掠过石桌边缘。",
        "谢临舟侧身避开，反手扣住对方手腕。",
        "谢临舟：谁派你来的？",
        "黑衣人咬碎齿间药丸，身体骤然倒地。",
      ].join("\n");
      updateScriptMetrics();
      scanDraft = null;
      $("#enterWorkspace").disabled = true;
      setScanSummary([], null, "");
      $("#proofEpisodes").textContent = "待识别";
      showToast("已载入 3 集示例剧本，请点击“识别剧本”。");
    });
    bindFileInput($("#scriptFile"), async (file) => {
      if (file.size > 20 * 1024 * 1024) {
        showToast("剧本文件不能超过 20MB。", true);
        return;
      }
      $("#scriptInput").value = await file.text();
      if (!$("#projectNameInput").value.trim()) $("#projectNameInput").value = file.name.replace(/\.[^.]+$/, "");
      scanDraft = null;
      $("#enterWorkspace").disabled = true;
      $("#scriptFileState").textContent = file.name;
      updateScriptMetrics();
      showToast("剧本已载入，请点击“识别剧本”。");
    });
    const dropZone = $("#scriptDrop");
    ["dragenter", "dragover"].forEach((type) => dropZone.addEventListener(type, (event) => {
      event.preventDefault();
      dropZone.classList.add("dragging");
    }));
    ["dragleave", "drop"].forEach((type) => dropZone.addEventListener(type, (event) => {
      event.preventDefault();
      dropZone.classList.remove("dragging");
    }));
    dropZone.addEventListener("drop", async (event) => {
      const file = event.dataTransfer.files && event.dataTransfer.files[0];
      if (!file) return;
      $("#scriptFile").files = event.dataTransfer.files;
      $("#scriptFile").dispatchEvent(new Event("change"));
    });
    bindFileInput($("#projectFile"), importProject);
    $("#importProjectButton").addEventListener("click", () => $("#projectFile").click());

    $("#episodeSearch").addEventListener("input", renderEpisodeList);
    $("#selectAllEpisodes").addEventListener("change", (event) => {
      const query = ($("#episodeSearch").value || "").trim().toLowerCase();
      const visible = state.episodes.filter((episode) => !query || episode.name.toLowerCase().includes(query));
      visible.forEach((episode) => {
        if (event.target.checked) selection.add(episode.id);
        else selection.delete(episode.id);
      });
      renderEpisodeList();
      renderGenerationState();
    });
    $("#episodeList").addEventListener("click", (event) => {
      const checkbox = event.target.closest("[data-select-episode]");
      if (checkbox) {
        if (checkbox.checked) selection.add(checkbox.dataset.selectEpisode);
        else selection.delete(checkbox.dataset.selectEpisode);
        renderGenerationState();
        return;
      }
      const item = event.target.closest("[data-episode-id]");
      if (!item) return;
      state.activeEpisodeId = item.dataset.episodeId;
      activeGroupIndex = 0;
      activeShotId = "";
      saveProject();
      renderWorkspace();
      if (window.innerWidth <= 720) setMobileView("groups");
    });
    $("#episodeList").addEventListener("keydown", (event) => {
      const item = event.target.closest("[data-episode-id]");
      if (item && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        item.click();
      }
    });
    $("#generateSelected").addEventListener("click", () => {
      const ids = selection.size ? Array.from(selection) : (getEpisode() ? [getEpisode().id] : []);
      generateEpisodes(ids);
    });
    $("#cancelGeneration").addEventListener("click", cancelGeneration);
    $("#generateCurrentEpisode").addEventListener("click", () => {
      const episode = getEpisode();
      if (episode) generateEpisodes([episode.id]);
    });
    $("#emptyGenerateButton").addEventListener("click", () => {
      const episode = getEpisode();
      if (episode) generateEpisodes([episode.id]);
    });
    $("#retryEpisode").addEventListener("click", () => {
      const episode = getEpisode();
      if (episode) generateEpisodes([episode.id]);
    });

    $("#groupSwitcher").addEventListener("click", (event) => {
      const tab = event.target.closest("[data-group-index]");
      if (!tab) return;
      activeGroupIndex = Number(tab.dataset.groupIndex);
      const group = getActiveGroup();
      activeShotId = group && group.shots[0] ? group.shots[0].id : "";
      renderGroupTabs();
      renderGroup();
      saveProject();
    });
    $("#previousGroup").addEventListener("click", () => moveActiveGroup(-1));
    $("#nextGroup").addEventListener("click", () => moveActiveGroup(1));
    $("#addGroup").addEventListener("click", addGroup);
    $("#deleteGroup").addEventListener("click", deleteCurrentGroup);
    $("#addShot").addEventListener("click", addShot);
    $("#copyGroupPrompt").addEventListener("click", copyCurrentGroupPrompt);
    $("#copyGroupPromptTop").addEventListener("click", copyCurrentGroupPrompt);
    $("#generationOverlayCancel").addEventListener("click", cancelGeneration);
    $("#duplicateGroup").addEventListener("click", duplicateGroup);
    $("#copyEpisode").addEventListener("click", duplicateEpisode);
    $("#shotGrid").addEventListener("click", (event) => {
      const empty = event.target.closest('[data-action="add-shot"]');
      if (empty) {
        addShot();
        return;
      }
      const copy = event.target.closest("[data-copy-group]");
      if (copy) {
        copyCurrentGroupPrompt();
        return;
      }
      const card = event.target.closest("[data-shot-id]");
      if (!card) return;
      activeShotId = card.dataset.shotId;
      renderGroup();
      if (window.innerWidth <= 980) setMobileView("detail");
    });
    $("#shotGrid").addEventListener("keydown", (event) => {
      const row = event.target.closest(".shot-sheet-row");
      if (row && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        row.click();
      }
    });
    ["groupTitleInput", "groupLocationInput", "groupEmotionInput", "groupDurationInput"].forEach((id) => {
      $("#" + id).addEventListener("input", () => {
        const group = getActiveGroup();
        if (!group) return;
        group.title = $("#groupTitleInput").value;
        group.location = $("#groupLocationInput").value;
        group.emotion = $("#groupEmotionInput").value;
        group.duration = numberValue($("#groupDurationInput").value, totalDuration(group.shots));
        saveProject();
      });
      $("#" + id).addEventListener("change", renderGroupTabs);
    });
    $("#shotForm").addEventListener("input", renderShotFormValues);
    $("#shotIdea").addEventListener("input", () => {
      const shot = getActiveShot();
      if (shot) shot.idea = $("#shotIdea").value;
      saveProject();
    });
    $("#shotForm").addEventListener("submit", (event) => {
      event.preventDefault();
      renderShotFormValues();
      saveProject(true);
      renderGroup();
      showToast("当前镜头已保存。");
    });
    $("#deleteShot").addEventListener("click", deleteCurrentShot);
    $("#rewriteShot").addEventListener("click", () => rewriteCurrentShot("idea"));
    $("#regenerateWithReferences").addEventListener("click", () => rewriteCurrentShot("references"));
    $("#addReference").addEventListener("click", () => $("#referenceFile").click());
    $("#referenceFile").multiple = true;
    $("#referenceFile").addEventListener("change", async () => {
      await addReferenceFiles($("#referenceFile").files);
      $("#referenceFile").value = "";
    });
    $("#referenceTypeTabs").addEventListener("click", (event) => {
      const button = event.target.closest("[data-ref-type]");
      if (!button) return;
      currentReferenceType = button.dataset.refType;
      renderReferences(getActiveShot());
    });
    $("#referenceSearch").addEventListener("input", (event) => {
      referenceQuery = event.target.value || "";
      renderReferences(getActiveShot());
    });
    $("#referenceList").addEventListener("click", (event) => {
      const remove = event.target.closest("[data-remove-reference]");
      if (remove) {
        removeReference(remove.dataset.removeReference);
        return;
      }
      if (event.target.closest("[data-add-reference]")) $("#referenceFile").click();
    });
    $("#mobileBackToEpisodes").addEventListener("click", () => setMobileView("episodes"));
    $("#mobileBackToShots").addEventListener("click", () => setMobileView("groups"));
    $$(".mobile-nav button").forEach((button) => button.addEventListener("click", () => setMobileView(button.dataset.mobileView)));

    $("#providerSelect").addEventListener("change", (event) => {
      captureProviderForm(modelDraftConfig, activeModelProviderId);
      renderProviderForm(modelDraftConfig, event.target.value);
    });
    $("#testConnection").addEventListener("click", testConnection);
    $("#saveModelSettings").addEventListener("click", saveModelSettings);
    $$("[data-close-modal]").forEach((button) => button.addEventListener("click", () => closeModal(button.dataset.closeModal)));
    $$(".modal-backdrop").forEach((backdrop) => backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) closeModal(backdrop.id);
    }));
    $("#saveRules").addEventListener("click", saveRules);
    $("#resetRules").addEventListener("click", resetRules);
    bindFileInput($("#rulesFile"), async (file) => {
      if (file.size > 2 * 1024 * 1024) {
        showToast("规则文件不能超过 2MB。", true);
        return;
      }
      $("#rulesInput").value = await file.text();
      $("#rulesFileLabel").textContent = file.name;
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        const open = $$(".modal-backdrop:not([hidden])").pop();
        if (open) closeModal(open.id);
      }
      if (event.ctrlKey || event.metaKey) {
        if (event.key.toLowerCase() === "s") {
          event.preventDefault();
          saveProject(true);
          showToast("项目已保存。");
        }
      }
    });
    bindDragEvents();
  }

  function init() {
    setTheme(localStorage.getItem(THEME_KEY) || "dark");
    state = loadStoredProject();
    state.rules = localStorage.getItem(RULES_KEY) || state.rules || P.rules || "";
    bindEvents();
    updateScriptMetrics();
    syncResponsiveWorkspace();
    if (state.episodes.length && state.project.script) {
      showDirector();
      setSaveState("", "已保存");
    } else {
      showSetup(false);
      if (state.project.script) showToast("上次项目草稿已恢复，请重新识别剧本。");
    }
    window.addEventListener("beforeunload", () => {
      if (state.project.script) saveProject(true);
    });
    window.addEventListener("resize", () => {
      syncResponsiveWorkspace();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
