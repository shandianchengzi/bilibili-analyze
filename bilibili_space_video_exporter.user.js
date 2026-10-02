// ==UserScript==
// @name         Bilibili UP主全部公开视频导出
// @namespace    https://space.bilibili.com/
// @version      1.0.1
// @description  在B站UP主空间中自动翻页获取全部公开投稿，并导出CSV/JSON。
// @author       ChatGPT
// @match        https://space.bilibili.com/*
// @connect      api.bilibili.com
// @require      https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.2.0/crypto-js.min.js
// @grant        GM_download
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  const API_BASE = 'https://api.bilibili.com';
  const PAGE_SIZE = 50;
  const PAGE_DELAY_MS = 650;
  const MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
    27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
    37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
    22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
  ];

  let running = false;
  let cancelled = false;
  let lastUid = null;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function getUidFromUrl() {
    const m = location.pathname.match(/^\/(\d+)(?:\/|$)/);
    return m ? m[1] : null;
  }

  function formatDate(unixSeconds) {
    if (!unixSeconds) return '';
    const d = new Date(Number(unixSeconds) * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function normalizeCover(url) {
    if (!url) return '';
    return url.startsWith('//') ? `https:${url}` : url;
  }

  function safeFilename(name) {
    return String(name || 'bilibili')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
  }

  function downloadBlob(filename, text, mimeType) {
    const blob = new Blob([text], { type: mimeType });

    const fallbackDownload = () => {
      // 不把 <a> 插入 B 站 DOM，避免其 SPA 全局点击处理器劫持 blob: URL。
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.style.display = 'none';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    };

    if (typeof GM_download !== 'function') {
      fallbackDownload();
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      try {
        GM_download({
          url: blob,
          name: filename,
          saveAs: false,
          onload: () => resolve(),
          onerror: (err) => {
            console.warn('[Bilibili投稿导出] GM_download失败，改用浏览器下载：', err);
            fallbackDownload();
            resolve();
          },
        });
      } catch (err) {
        console.warn('[Bilibili投稿导出] GM_download异常，改用浏览器下载：', err);
        fallbackDownload();
        resolve();
      }
    });
  }

  function toCsv(rows) {
    if (!rows.length) return '\ufeff';
    const columns = [
      ['序号', 'index'],
      ['标题', 'title'],
      ['BV号', 'bvid'],
      ['AV号', 'aid'],
      ['视频链接', 'url'],
      ['封面', 'cover'],
      ['发布时间', 'publish_time'],
      ['发布时间戳', 'publish_timestamp'],
      ['时长', 'duration'],
      ['简介', 'description'],
      ['播放量', 'play'],
      ['弹幕数', 'danmaku'],
      ['评论数', 'comments'],
      ['收藏数', 'favorites'],
      ['分区ID', 'typeid'],
      ['UP主', 'author'],
      ['UP主UID', 'mid'],
      ['版权类型', 'copyright'],
      ['合作视频', 'is_union_video'],
    ];

    const esc = (v) => {
      const s = v == null ? '' : String(v);
      return `"${s.replace(/"/g, '""')}"`;
    };

    const lines = [
      columns.map(([label]) => esc(label)).join(','),
      ...rows.map((row) => columns.map(([, key]) => esc(row[key])).join(',')),
    ];
    return '\ufeff' + lines.join('\r\n');
  }

  async function apiFetch(path, params = null) {
    const url = new URL(API_BASE + path);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }

    const response = await fetch(url.toString(), {
      method: 'GET',
      credentials: 'include',
      mode: 'cors',
      headers: {
        Accept: 'application/json, text/plain, */*',
      },
      referrer: location.href,
      referrerPolicy: 'strict-origin-when-cross-origin',
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    const json = await response.json();
    return json;
  }

  function getMixinKey(orig) {
    return MIXIN_KEY_ENC_TAB.map((n) => orig[n]).join('').slice(0, 32);
  }

  async function getWbiKeys() {
    const json = await apiFetch('/x/web-interface/nav');
    if (json.code !== 0 || !json.data?.wbi_img) {
      throw new Error(`获取WBI密钥失败：${json.message || json.code}`);
    }

    const { img_url, sub_url } = json.data.wbi_img;
    const stem = (url) => url.slice(url.lastIndexOf('/') + 1, url.lastIndexOf('.'));
    return { imgKey: stem(img_url), subKey: stem(sub_url) };
  }

  function signWbi(params, imgKey, subKey) {
    const mixinKey = getMixinKey(imgKey + subKey);
    const signed = { ...params, wts: Math.floor(Date.now() / 1000) };
    const chrFilter = /[!'()*]/g;

    const query = Object.keys(signed)
      .sort()
      .map((key) => {
        const value = String(signed[key]).replace(chrFilter, '');
        return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
      })
      .join('&');

    const wRid = CryptoJS.MD5(query + mixinKey).toString();
    return `${query}&w_rid=${wRid}`;
  }

  async function fetchVideoPage(uid, pn, imgKey, subKey) {
    const params = {
      mid: uid,
      pn,
      ps: PAGE_SIZE,
      order: 'pubdate',
      tid: 0,
      keyword: '',
      platform: 'web',
      web_location: 1550101,
      order_avoided: true,
    };

    const query = signWbi(params, imgKey, subKey);
    const json = await apiFetch(`/x/space/wbi/arc/search?${query}`);

    if (json.code !== 0) {
      const extra = json.code === -352
        ? '（触发风控 -352。请确认已登录B站，刷新空间页后稍等再试。）'
        : json.code === -412
          ? '（请求被拦截 -412。建议暂停几分钟后重试。）'
          : '';
      throw new Error(`第 ${pn} 页请求失败：${json.code} ${json.message || ''}${extra}`);
    }
    return json.data;
  }

  function normalizeVideo(v, index) {
    const created = Number(v.created || v.pubdate || 0);
    const bvid = v.bvid || '';
    return {
      index,
      title: v.title || '',
      bvid,
      aid: v.aid ?? '',
      url: bvid ? `https://www.bilibili.com/video/${bvid}` : (v.arcurl || ''),
      cover: normalizeCover(v.pic),
      publish_time: formatDate(created),
      publish_timestamp: created || '',
      duration: v.length || '',
      description: v.description || '',
      play: v.play ?? '',
      danmaku: v.video_review ?? '',
      comments: v.comment ?? v.review ?? '',
      favorites: v.favorites ?? '',
      typeid: v.typeid ?? '',
      author: v.author || '',
      mid: v.mid ?? '',
      copyright: v.copyright ?? '',
      is_union_video: v.is_union_video ?? '',
      raw: v,
    };
  }

  function createUi() {
    if (document.getElementById('bili-all-video-exporter')) return;

    const root = document.createElement('div');
    root.id = 'bili-all-video-exporter';
    root.innerHTML = `
      <div class="bae-title">UP主投稿导出</div>
      <div class="bae-status">等待开始</div>
      <div class="bae-actions">
        <button class="bae-start">导出全部公开视频</button>
        <button class="bae-cancel" disabled>停止</button>
      </div>
    `;

    const style = document.createElement('style');
    style.textContent = `
      #bili-all-video-exporter {
        position: fixed; right: 20px; bottom: 24px; z-index: 2147483647;
        width: 280px; padding: 14px; box-sizing: border-box;
        background: rgba(255,255,255,.97); color: #18191c;
        border: 1px solid #e3e5e7; border-radius: 10px;
        box-shadow: 0 6px 24px rgba(0,0,0,.16);
        font: 14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;
      }
      #bili-all-video-exporter .bae-title { font-weight: 700; margin-bottom: 7px; }
      #bili-all-video-exporter .bae-status { min-height: 42px; color: #61666d; white-space: pre-wrap; word-break: break-word; }
      #bili-all-video-exporter .bae-actions { display: flex; gap: 8px; margin-top: 10px; }
      #bili-all-video-exporter button {
        border: 0; border-radius: 6px; padding: 7px 10px; cursor: pointer;
        font-size: 13px;
      }
      #bili-all-video-exporter .bae-start { flex: 1; background: #00aeec; color: #fff; }
      #bili-all-video-exporter .bae-cancel { background: #f1f2f3; color: #61666d; }
      #bili-all-video-exporter button:disabled { opacity: .5; cursor: not-allowed; }
    `;

    document.documentElement.appendChild(style);
    document.body.appendChild(root);

    root.querySelector('.bae-start').addEventListener('click', runExport);
    root.querySelector('.bae-cancel').addEventListener('click', () => {
      cancelled = true;
      setStatus('正在停止……');
    });
  }

  function setStatus(text) {
    const el = document.querySelector('#bili-all-video-exporter .bae-status');
    if (el) el.textContent = text;
  }

  function setButtons(isRunning) {
    const start = document.querySelector('#bili-all-video-exporter .bae-start');
    const cancel = document.querySelector('#bili-all-video-exporter .bae-cancel');
    if (start) start.disabled = isRunning;
    if (cancel) cancel.disabled = !isRunning;
  }

  async function runExport() {
    if (running) return;
    const uid = getUidFromUrl();
    if (!uid) {
      setStatus('没有从当前网址识别到UP主UID。');
      return;
    }

    running = true;
    cancelled = false;
    setButtons(true);

    try {
      setStatus(`UID ${uid}\n正在获取WBI签名密钥……`);
      const { imgKey, subKey } = await getWbiKeys();

      setStatus(`UID ${uid}\n正在读取第 1 页……`);
      const first = await fetchVideoPage(uid, 1, imgKey, subKey);
      const total = Number(first?.page?.count || 0);
      const firstList = first?.list?.vlist || [];
      const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      const all = [...firstList];

      for (let pn = 2; pn <= pages; pn++) {
        if (cancelled) throw new Error('已由用户停止。');
        setStatus(`共 ${total} 个公开视频\n正在读取第 ${pn}/${pages} 页，已获取 ${all.length} 个……`);
        await sleep(PAGE_DELAY_MS);
        const data = await fetchVideoPage(uid, pn, imgKey, subKey);
        const list = data?.list?.vlist || [];
        all.push(...list);
        if (!list.length) break;
      }

      if (cancelled) throw new Error('已由用户停止。');

      // 去重，避免空间接口偶发分页漂移造成重复。
      const seen = new Set();
      const deduped = all.filter((v) => {
        const key = v.bvid || `av${v.aid}`;
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      const rows = deduped.map((v, i) => normalizeVideo(v, i + 1));
      const author = rows.find((x) => x.author)?.author || `UID_${uid}`;
      const base = safeFilename(`${author}_${uid}_公开投稿_${new Date().toISOString().slice(0, 10)}`);

      const jsonOutput = {
        exported_at: new Date().toISOString(),
        uid,
        author,
        reported_total: total,
        exported_total: rows.length,
        source: location.href,
        videos: rows,
      };

      await downloadBlob(`${base}.json`, JSON.stringify(jsonOutput, null, 2), 'application/json;charset=utf-8');
      await sleep(250);
      await downloadBlob(`${base}.csv`, toCsv(rows), 'text/csv;charset=utf-8');

      setStatus(`完成。\n接口报告 ${total} 个，实际导出 ${rows.length} 个。\n已下载 JSON + CSV。`);
    } catch (err) {
      console.error('[Bilibili投稿导出]', err);
      setStatus(`失败：${err?.message || err}`);
    } finally {
      running = false;
      setButtons(false);
    }
  }

  function ensureUiForCurrentPage() {
    const uid = getUidFromUrl();
    if (!uid) return;
    if (uid !== lastUid) lastUid = uid;
    createUi();
  }

  ensureUiForCurrentPage();
  setInterval(ensureUiForCurrentPage, 1500);
})();
