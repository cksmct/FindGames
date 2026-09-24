/**
 * 存储层：历史留档(7 天滚动) + 分片输出 + 游戏雷达档案
 *
 * 产物格式与原站对齐：
 *   data/trends.json        { updated, geos[], cats{}, items{ GEO:[...] } }
 *   data/history.json       { updated, chunks, items[] }   ← 首片，最多 chunkSize 条
 *   data/history-p2.json... { items[] }                    ← 其余分片
 *   data/games.json         { updated, items[] }
 *   data/.state.json        采集状态(运行轮次等，内部用)
 */
import path from "node:path";
import fs from "node:fs";
import { dataPath, readJson, writeJson, ensureDir, iso, log } from "./util.mjs";
import { matchWatch } from "./detect.mjs";

const keyOf = (q, geo) => `${geo}|${q}`;

/** 读取完整历史（首片 + 所有分片） */
export function loadHistory(cfg) {
  const first = readJson(dataPath(cfg, "history.json"));
  if (!first) return { updated: null, items: [], chunks: 1 };
  const items = Array.isArray(first.items) ? [...first.items] : [];
  const chunks = Number(first.chunks) || 1;
  for (let i = 2; i <= chunks; i++) {
    const p = readJson(dataPath(cfg, `history-p${i}.json`));
    if (p?.items) items.push(...p.items);
  }
  return { updated: first.updated || null, items, chunks };
}

/**
 * 把本轮采集合并进历史
 * @param {Array} historyItems 既有历史
 * @param {Array} fresh 本轮条目 [{q,geo,vol,growth,cats,noise}]
 * @param {object} cfg
 * @returns {{items:Array, newKeys:Set<string>, stats:object}}
 */
export function mergeHistory(historyItems, fresh, cfg) {
  const now = iso();
  const nowMs = Date.now();
  const keepMs = (cfg.historyDays || 7) * 86400_000;
  const map = new Map();
  for (const it of historyItems) {
    if (!it || !it.q || !it.geo) continue;
    map.set(keyOf(it.q, it.geo), it);
  }

  const newKeys = new Set();
  for (const f of fresh) {
    const k = keyOf(f.q, f.geo);
    const cur = map.get(k);
    if (!cur) {
      newKeys.add(k);
      map.set(k, {
        q: f.q,
        geo: f.geo,
        cats: f.cats || [],
        vol_peak: f.vol || 0,
        growth_peak: f.growth || 0,
        first: f.ts || now,
        last: now,
        sightings: 1,
        noise: f.noise || "",
        zh: f.zh || "",
        watch: matchWatch(f.q, cfg.watch || []),
      });
    } else {
      cur.last = now;
      cur.sightings = (cur.sightings || 1) + 1;
      if ((f.vol || 0) > (cur.vol_peak || 0)) cur.vol_peak = f.vol;
      if ((f.growth || 0) > (cur.growth_peak || 0)) cur.growth_peak = f.growth;
      const merged = new Set([...(cur.cats || []), ...(f.cats || [])]);
      cur.cats = Array.from(merged);
      if (!cur.first) cur.first = f.ts || now;
      if (f.noise) cur.noise = f.noise;
    }
  }

  let items = Array.from(map.values());
  const before = items.length;
  items = items.filter((it) => nowMs - new Date(it.last).getTime() <= keepMs);
  items.sort((a, b) => (b.vol_peak || 0) - (a.vol_peak || 0));

  return {
    items,
    newKeys,
    stats: { total: items.length, pruned: before - items.length, added: newKeys.size },
  };
}

/** 写历史(分片) */
export function writeHistory(cfg, items) {
  const size = cfg.historyChunkSize || 3000;
  const chunks = Math.max(1, Math.ceil(items.length / size));
  writeJson(dataPath(cfg, "history.json"), {
    updated: iso(),
    chunks,
    items: items.slice(0, size),
  });
  for (let i = 2; i <= chunks; i++) {
    writeJson(dataPath(cfg, `history-p${i}.json`), {
      updated: iso(),
      items: items.slice((i - 1) * size, i * size),
    });
  }
  // 清理多余旧分片
  const dir = dataPath(cfg);
  for (const f of fs.readdirSync(dir)) {
    const m = /^history-p(\d+)\.json$/.exec(f);
    if (m && Number(m[1]) > chunks) {
      fs.unlinkSync(path.join(dir, f));
      log("dim", `清理旧分片 ${f}`);
    }
  }
  return chunks;
}

export function writeTrends(cfg, { geos, cats, items, updated, compareWith, defaultGeo }) {
  // compareWith 会透出到前端：所有点出去的 Google Trends 链接都带上它做对比基准词
  // defaultGeo 同理：看板点"查看趋势"时 geo 的缺省值（"全部地区"视图用）。
  // ⚠️ 这两个字段必须在解构参数里显式列出 —— 曾经漏了 defaultGeo，
  //    调用方传了值却被静默丢弃，产物里查不到、也不报错，排查起来很费时间。
  writeJson(dataPath(cfg, "trends.json"), {
    updated,
    geos,
    cats,
    items,
    ...(compareWith ? { compareWith } : {}),
    ...(defaultGeo ? { defaultGeo } : {}),
  });
}

export function loadGames(cfg) {
  return readJson(dataPath(cfg, "games.json")) || { updated: null, items: [] };
}

export function writeGames(cfg, items, meta = {}) {
  // meta 用来随产物下发"算法自述"（如 scoring）—— 前端据实展示，避免两处数字漂移
  writeJson(dataPath(cfg, "games.json"), { updated: iso(), ...meta, items });
}

export function readState(cfg) {
  return readJson(dataPath(cfg, ".state.json")) || { runs: 0 };
}

export function writeState(cfg, state) {
  ensureDir(dataPath(cfg));
  writeJson(dataPath(cfg, ".state.json"), { ...state, lastRun: iso() }, true);
}
