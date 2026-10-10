// ==UserScript==
// @name         Bilibili 投稿与视频章节导出
// @namespace    https://github.com/shandianchengzi/bilibili-analyze
// @version      1.4.0
// @description  获取UP主公开投稿；在视频播放页获取全部分P标题以及当前P内的章节/看点。
// @author       shandianchengzi
// @license      MIT
// @homepageURL  https://github.com/shandianchengzi/bilibili-analyze
// @supportURL   https://github.com/shandianchengzi/bilibili-analyze/issues
// @name:en      Bilibili Uploads and Video Chapters Exporter
// @description:en Export public uploads with collection filters, and copy or export video chapters as JSON and CSV.
// @match        https://space.bilibili.com/*
// @match        https://www.bilibili.com/video/*
// @require      https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.2.0/crypto-js.min.js
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      api.bilibili.com
// @connect      member.bilibili.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const API_BASE = 'https://api.bilibili.com';
  const MEMBER_API_BASE = 'https://member.bilibili.com';
  const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
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
  let fetchedRows = [];
  let exportContext = null;

  let chapterRows = [];
  let chapterContext = null;
  let lastVideoKey = null;
  let partRows = [];
  let partContext = null;
  let lastPartBvid = null;

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
    if (url.startsWith('//')) return `https:${url}`;
    if (url.startsWith('http://')) return `https://${url.slice(7)}`;
    return url;
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
      ['是否加入合集', 'in_collection'],
      ['合集ID', 'season_id'],
      ['合集名称', 'season_title'],
      ['合集视频数', 'season_ep_count'],
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

  async function pageFetchJson(url) {
    const fetchImpl = pageWindow && pageWindow.fetch;
    if (typeof fetchImpl !== 'function') throw new Error('无法访问页面 fetch，不能复用当前 B 站登录态。');

    const response = await fetchImpl.call(pageWindow, url, {
      method: 'GET',
      credentials: 'include',
      mode: 'cors',
      headers: { Accept: 'application/json, text/plain, */*' },
      referrer: location.href,
      referrerPolicy: 'strict-origin-when-cross-origin',
    });

    if (!response.ok) throw new Error('HTTP ' + response.status + ' ' + response.statusText);
    return JSON.parse(await response.text());
  }

  function gmFetchJson(url) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') {
        reject(new Error('GM_xmlhttpRequest 不可用。'));
        return;
      }
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        anonymous: false,
        headers: { Accept: 'application/json, text/plain, */*', Referer: location.href },
        timeout: 20000,
        onload: (response) => {
          if (response.status < 200 || response.status >= 300) {
            reject(new Error(('HTTP ' + response.status + ' ' + (response.statusText || '')).trim()));
            return;
          }
          try { resolve(JSON.parse(response.responseText)); }
          catch (err) { reject(new Error('响应不是合法 JSON：' + (err && err.message ? err.message : err))); }
        },
        ontimeout: () => reject(new Error('请求超时。')),
        onerror: (err) => reject(new Error('请求失败：' + ((err && (err.error || err.message)) || '未知错误'))),
      });
    });
  }

  async function apiFetch(path, params = null) {
    const url = new URL(API_BASE + path);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }
    try {
      return await pageFetchJson(url.toString());
    } catch (pageErr) {
      console.warn('[Bilibili API] 页面 fetch 失败，尝试 GM_xmlhttpRequest：', pageErr);
      return gmFetchJson(url.toString());
    }
  }

  async function memberApiFetch(path, params = null) {
    const url = new URL(MEMBER_API_BASE + path);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }
    return gmFetchJson(url.toString());
  }

  async function getBilibiliLoginState() {
    const json = await apiFetch('/x/web-interface/nav');
    const data = (json && json.data) || {};
    return {
      code: json && json.code,
      isLogin: Boolean(data.isLogin),
      mid: Number(data.mid || 0),
      uname: data.uname || '',
    };
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
    const seasonId = Number(v.season_id || v.meta?.id || v.meta?.stat?.season_id || 0);
    const seasonTitle = v.meta?.title || '';
    const seasonEpCount = Number(v.meta?.ep_count || v.meta?.ep_num || 0);
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
      in_collection: seasonId > 0 ? '是' : '否',
      season_id: seasonId,
      season_title: seasonTitle,
      season_ep_count: seasonEpCount,
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
        <button class="bae-start">获取投稿列表</button>
        <button class="bae-reexport" disabled>选择并导出</button>
        <button class="bae-cancel" disabled>停止</button>
      </div>
    `;

    const style = document.createElement('style');
    style.textContent = `
      #bili-all-video-exporter {
        position: fixed; right: 20px; bottom: 24px; z-index: 2147483647;
        width: 300px; padding: 14px; box-sizing: border-box;
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
      #bili-all-video-exporter .bae-reexport { flex: 1; background: #00b578; color: #fff; }
      #bili-all-video-exporter .bae-cancel { background: #f1f2f3; color: #61666d; }
      #bili-all-video-exporter button:disabled { opacity: .5; cursor: not-allowed; }
    `;

    document.documentElement.appendChild(style);
    document.body.appendChild(root);

    root.querySelector('.bae-start').addEventListener('click', runExport);
    root.querySelector('.bae-reexport').addEventListener('click', () => {
      if (!fetchedRows.length || !exportContext) {
        setStatus('还没有已获取的投稿列表，请先点击“获取投稿列表”。');
        return;
      }
      showSelectionDialog(fetchedRows, exportContext);
    });
    root.querySelector('.bae-cancel').addEventListener('click', () => {
      cancelled = true;
      setStatus('正在停止……');
    });
  }


  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function closeSelectionDialog() {
    document.getElementById('bae-selection-overlay')?.remove();
    document.getElementById('bae-selection-style')?.remove();
  }

  function showSelectionDialog(rows, context) {
    closeSelectionDialog();

    const selected = new Set(
      rows.filter((row) => !row.season_id).map((row) => String(row.bvid || row.aid))
    );

    const overlay = document.createElement('div');
    overlay.id = 'bae-selection-overlay';
    overlay.innerHTML = `
      <div class="bae-modal">
        <div class="bae-modal-header">
          <div>
            <div class="bae-modal-title">选择要导出的视频</div>
            <div class="bae-modal-summary">
              共 ${rows.length} 个投稿，其中未加入合集
              <strong>${rows.filter((r) => !r.season_id).length}</strong> 个。
              默认已选中全部未加入合集的视频。
            </div>
          </div>
          <button class="bae-close" title="关闭">×</button>
        </div>

        <div class="bae-toolbar">
          <select class="bae-filter">
            <option value="uncollected" selected>未加入合集</option>
            <option value="all">全部投稿</option>
            <option value="collected">已加入合集</option>
          </select>
          <input class="bae-search" type="search" placeholder="搜索标题…" />
          <button class="bae-select-visible">全选当前筛选</button>
          <button class="bae-clear-visible">清空当前筛选</button>
        </div>

        <div class="bae-list-head">
          <span class="bae-visible-count"></span>
          <span class="bae-selected-count"></span>
        </div>
        <div class="bae-video-list"></div>

        <div class="bae-modal-footer">
          <button class="bae-close-footer">取消</button>
          <button class="bae-export-selected">导出已选视频</button>
        </div>
      </div>
    `;

    const style = document.createElement('style');
    style.id = 'bae-selection-style';
    style.textContent = `
      #bae-selection-overlay {
        position: fixed; inset: 0; z-index: 2147483647;
        background: rgba(0,0,0,.48); display: flex; align-items: center; justify-content: center;
        padding: 24px; box-sizing: border-box;
        font: 14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;
      }
      #bae-selection-overlay .bae-modal {
        width: min(980px, 96vw); height: min(760px, 92vh);
        background: #fff; color: #18191c; border-radius: 12px;
        box-shadow: 0 12px 42px rgba(0,0,0,.28); display: flex; flex-direction: column;
        overflow: hidden;
      }
      #bae-selection-overlay .bae-modal-header {
        display: flex; justify-content: space-between; gap: 16px; align-items: flex-start;
        padding: 18px 20px 14px; border-bottom: 1px solid #e3e5e7;
      }
      #bae-selection-overlay .bae-modal-title { font-size: 18px; font-weight: 700; }
      #bae-selection-overlay .bae-modal-summary { margin-top: 5px; color: #61666d; }
      #bae-selection-overlay .bae-close {
        border: 0; background: transparent; font-size: 26px; line-height: 1; cursor: pointer; color: #9499a0;
      }
      #bae-selection-overlay .bae-toolbar {
        display: flex; gap: 8px; padding: 12px 20px; border-bottom: 1px solid #eee; flex-wrap: wrap;
      }
      #bae-selection-overlay select,
      #bae-selection-overlay input,
      #bae-selection-overlay button {
        font: inherit;
      }
      #bae-selection-overlay .bae-filter,
      #bae-selection-overlay .bae-search {
        border: 1px solid #c9ccd0; border-radius: 6px; padding: 7px 9px; background: #fff;
      }
      #bae-selection-overlay .bae-search { flex: 1; min-width: 180px; }
      #bae-selection-overlay .bae-toolbar button,
      #bae-selection-overlay .bae-modal-footer button {
        border: 1px solid #c9ccd0; border-radius: 6px; padding: 7px 11px; background: #fff; cursor: pointer;
      }
      #bae-selection-overlay .bae-list-head {
        display: flex; justify-content: space-between; padding: 8px 20px; color: #61666d;
        background: #f6f7f8; border-bottom: 1px solid #eee;
      }
      #bae-selection-overlay .bae-video-list { flex: 1; overflow: auto; }
      #bae-selection-overlay .bae-row {
        display: grid; grid-template-columns: 32px 92px minmax(0, 1fr) 150px;
        gap: 10px; align-items: center; padding: 10px 20px; border-bottom: 1px solid #f1f2f3;
      }
      #bae-selection-overlay .bae-row:hover { background: #fafafa; }
      #bae-selection-overlay .bae-cover {
        width: 92px; height: 58px; object-fit: cover; border-radius: 5px; background: #eee;
      }
      #bae-selection-overlay .bae-video-title {
        color: #18191c; text-decoration: none; font-weight: 600; display: block;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      #bae-selection-overlay .bae-video-title:hover { color: #00aeec; }
      #bae-selection-overlay .bae-meta { margin-top: 5px; color: #9499a0; font-size: 12px; }
      #bae-selection-overlay .bae-season {
        color: #61666d; font-size: 12px; overflow: hidden; text-overflow: ellipsis;
      }
      #bae-selection-overlay .bae-no-season { color: #d4380d; }
      #bae-selection-overlay .bae-modal-footer {
        display: flex; justify-content: flex-end; gap: 10px; padding: 13px 20px;
        border-top: 1px solid #e3e5e7; background: #fff;
      }
      #bae-selection-overlay .bae-export-selected {
        background: #00aeec !important; color: #fff; border-color: #00aeec !important;
      }
      #bae-selection-overlay .bae-export-selected:disabled { opacity: .5; cursor: not-allowed; }
    `;
    document.documentElement.appendChild(style);
    document.body.appendChild(overlay);

    const listEl = overlay.querySelector('.bae-video-list');
    const filterEl = overlay.querySelector('.bae-filter');
    const searchEl = overlay.querySelector('.bae-search');
    const visibleCountEl = overlay.querySelector('.bae-visible-count');
    const selectedCountEl = overlay.querySelector('.bae-selected-count');
    const exportBtn = overlay.querySelector('.bae-export-selected');

    const keyOf = (row) => String(row.bvid || row.aid);

    function getVisibleRows() {
      const mode = filterEl.value;
      const keyword = searchEl.value.trim().toLowerCase();
      return rows.filter((row) => {
        const collectionMatch =
          mode === 'all' ||
          (mode === 'uncollected' && !row.season_id) ||
          (mode === 'collected' && !!row.season_id);
        const keywordMatch = !keyword || row.title.toLowerCase().includes(keyword);
        return collectionMatch && keywordMatch;
      });
    }

    function updateCounts(visibleRows) {
      visibleCountEl.textContent = `当前显示 ${visibleRows.length} 个`;
      selectedCountEl.textContent = `已选 ${selected.size} 个`;
      exportBtn.disabled = selected.size === 0;
      exportBtn.textContent = selected.size ? `导出已选视频（${selected.size}）` : '导出已选视频';
    }

    function render() {
      const visibleRows = getVisibleRows();
      listEl.innerHTML = visibleRows.map((row) => {
        const key = keyOf(row);
        const checked = selected.has(key) ? 'checked' : '';
        const collection = row.season_id
          ? `<span>合集：${escapeHtml(row.season_title || String(row.season_id))}</span>`
          : '<span class="bae-no-season">未加入合集</span>';
        return `
          <label class="bae-row">
            <input class="bae-check" type="checkbox" data-key="${escapeHtml(key)}" ${checked} />
            <img class="bae-cover" src="${escapeHtml(row.cover)}" loading="lazy" />
            <div>
              <a class="bae-video-title" href="${escapeHtml(row.url)}" target="_blank" rel="noopener noreferrer">
                ${escapeHtml(row.title)}
              </a>
              <div class="bae-meta">${escapeHtml(row.publish_time)} · ${escapeHtml(row.duration)} · ${escapeHtml(row.bvid)}</div>
            </div>
            <div class="bae-season">${collection}</div>
          </label>
        `;
      }).join('');

      listEl.querySelectorAll('.bae-check').forEach((checkbox) => {
        checkbox.addEventListener('change', () => {
          const key = checkbox.dataset.key;
          if (checkbox.checked) selected.add(key);
          else selected.delete(key);
          updateCounts(visibleRows);
        });
      });

      updateCounts(visibleRows);
    }

    filterEl.addEventListener('change', render);
    searchEl.addEventListener('input', render);

    overlay.querySelector('.bae-select-visible').addEventListener('click', () => {
      getVisibleRows().forEach((row) => selected.add(keyOf(row)));
      render();
    });

    overlay.querySelector('.bae-clear-visible').addEventListener('click', () => {
      getVisibleRows().forEach((row) => selected.delete(keyOf(row)));
      render();
    });

    const close = () => closeSelectionDialog();
    overlay.querySelector('.bae-close').addEventListener('click', close);
    overlay.querySelector('.bae-close-footer').addEventListener('click', close);

    exportBtn.addEventListener('click', async () => {
      const chosen = rows
        .filter((row) => selected.has(keyOf(row)))
        .map((row, i) => ({ ...row, index: i + 1 }));

      if (!chosen.length) return;

      exportBtn.disabled = true;
      exportBtn.textContent = '正在导出……';

      try {
        const suffix = chosen.every((r) => !r.season_id) ? '未加入合集' : '已选投稿';
        const base = safeFilename(
          `${context.author}_${context.uid}_${suffix}_${new Date().toISOString().slice(0, 10)}`
        );
        const jsonOutput = {
          exported_at: new Date().toISOString(),
          uid: context.uid,
          author: context.author,
          reported_total: context.reportedTotal,
          available_total: rows.length,
          exported_total: chosen.length,
          filter_note: suffix,
          source: context.source,
          videos: chosen,
        };

        await downloadBlob(
          `${base}.json`,
          JSON.stringify(jsonOutput, null, 2),
          'application/json;charset=utf-8'
        );
        await sleep(250);
        await downloadBlob(`${base}.csv`, toCsv(chosen), 'text/csv;charset=utf-8');

        setStatus(`已导出 ${chosen.length} 个视频。\n可点击“选择并导出”继续使用当前已获取列表。`);
        closeSelectionDialog();
      } catch (err) {
        console.error('[Bilibili投稿导出]', err);
        alert(`导出失败：${err?.message || err}`);
        exportBtn.disabled = false;
        updateCounts(getVisibleRows());
      }
    });

    render();
  }

  function setStatus(text) {
    const el = document.querySelector('#bili-all-video-exporter .bae-status');
    if (el) el.textContent = text;
  }

  function setButtons(isRunning) {
    const start = document.querySelector('#bili-all-video-exporter .bae-start');
    const reexport = document.querySelector('#bili-all-video-exporter .bae-reexport');
    const cancel = document.querySelector('#bili-all-video-exporter .bae-cancel');
    if (start) start.disabled = isRunning;
    if (reexport) reexport.disabled = isRunning || !fetchedRows.length || !exportContext;
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
      const uncollectedCount = rows.filter((row) => !row.season_id).length;

      fetchedRows = rows;
      exportContext = {
        uid,
        author,
        reportedTotal: total,
        source: location.href,
      };
      setButtons(false);

      setStatus(
        `读取完成：${rows.length} 个公开视频。\n其中 ${uncollectedCount} 个未加入合集。\n请在弹出的列表中选择要导出的条目。`
      );
      showSelectionDialog(fetchedRows, exportContext);
    } catch (err) {
      console.error('[Bilibili投稿导出]', err);
      setStatus(`失败：${err?.message || err}`);
    } finally {
      running = false;
      setButtons(false);
    }
  }


  function getBvidFromUrl() {
    const m = location.pathname.match(/^\/video\/(BV[0-9A-Za-z]+)/i);
    return m ? m[1] : null;
  }

  function getCurrentVideoPageNo() {
    const p = Number(new URL(location.href).searchParams.get('p') || 1);
    return Number.isFinite(p) && p > 0 ? Math.floor(p) : 1;
  }

  function formatClock(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  function toChapterCsv(rows) {
    const columns = [
      ['序号', 'index'],
      ['章节标题', 'title'],
      ['开始时间', 'start_time'],
      ['结束时间', 'end_time'],
      ['开始秒数', 'from'],
      ['结束秒数', 'to'],
      ['持续秒数', 'duration_seconds'],
      ['章节图片', 'image_url'],
      ['类型', 'type'],
      ['团队类型', 'team_type'],
      ['团队名称', 'team_name'],
    ];

    const esc = (v) => {
      const s = v == null ? '' : String(v);
      return `"${s.replace(/"/g, '""')}"`;
    };

    return '\ufeff' + [
      columns.map(([label]) => esc(label)).join(','),
      ...rows.map((row) => columns.map(([, key]) => esc(row[key])).join(',')),
    ].join('\r\n');
  }

  function normalizeCreatorVideoDetail(data, bvid) {
    const archive = (data && (data.archive || data.Archive)) || {};
    const rawVideos = Array.isArray(data && data.videos) ? data.videos : [];
    const pages = rawVideos.map((v, i) => ({
      cid: Number(v.cid || v.id || 0),
      page: i + 1,
      part: v.title || v.part || ('P' + (i + 1)),
      duration: Number(v.duration || 0),
      raw: v,
    })).filter((p) => p.cid);

    const aid = Number(archive.aid || (data && data.aid) || 0);
    const normalizedBvid = archive.bvid || (data && data.bvid) || bvid;
    if (!aid && !pages.length) return null;

    return {
      ...archive,
      aid,
      bvid: normalizedBvid,
      title: archive.title || (data && data.title) || document.title.replace(/_哔哩哔哩_bilibili.*$/i, ''),
      cid: (pages[0] && pages[0].cid) || Number((data && data.cid) || 0),
      pages,
      _detail_source: 'creator-center',
      _creator_raw: data,
    };
  }

  function getPageEmbeddedVideoDetail(bvid) {
    try {
      const state = pageWindow && pageWindow.__INITIAL_STATE__;
      const candidates = [
        state && state.videoData,
        state && state.videoInfo,
        state && state.videoData && state.videoData.View,
        state && state.videoInfo && state.videoInfo.view,
      ].filter(Boolean);

      for (const v of candidates) {
        const candidateBvid = v.bvid || (v.View && v.View.bvid) || '';
        if (candidateBvid && candidateBvid.toLowerCase() !== bvid.toLowerCase()) continue;

        const rawPages = Array.isArray(v.pages)
          ? v.pages
          : (v.View && Array.isArray(v.View.pages) ? v.View.pages : []);

        const pages = rawPages.map((p, i) => ({
          ...p,
          cid: Number(p.cid || 0),
          page: Number(p.page || i + 1),
          part: p.part || p.title || ('P' + (i + 1)),
        })).filter((p) => p.cid);

        const aid = Number(v.aid || (v.View && v.View.aid) || 0);
        const cid = Number(v.cid || (v.View && v.View.cid) || (pages[0] && pages[0].cid) || 0);
        if (!aid && !cid && !pages.length) continue;

        return {
          ...v,
          aid,
          bvid: candidateBvid || bvid,
          cid,
          title: v.title || (v.View && v.View.title) || document.title.replace(/_哔哩哔哩_bilibili.*$/i, ''),
          pages: pages.length ? pages : (cid ? [{ cid, page: 1, part: v.title || 'P1' }] : []),
          _detail_source: 'page-state',
        };
      }
    } catch (err) {
      console.warn('[Bilibili章节导出] 读取页面内嵌视频状态失败：', err);
    }
    return null;
  }

  async function fetchVideoDetail(bvid) {
    let publicError = null;

    try {
      const json = await apiFetch('/x/web-interface/view', { bvid });
      if (json.code === 0 && json.data) {
        return { ...json.data, _detail_source: 'public-api' };
      }
      publicError = new Error('公开详情接口：' + json.code + ' ' + (json.message || ''));
    } catch (err) {
      publicError = err;
    }

    try {
      const creatorJson = await memberApiFetch('/x/vupre/web/archive/view', {
        topic_grey: 1,
        bvid,
        t: Date.now(),
      });
      if (creatorJson.code === 0 && creatorJson.data) {
        const normalized = normalizeCreatorVideoDetail(creatorJson.data, bvid);
        if (normalized) return normalized;
      }
      console.warn('[Bilibili章节导出] 创作中心详情接口未返回有效稿件：', creatorJson);
    } catch (err) {
      console.warn('[Bilibili章节导出] 创作中心详情接口失败：', err);
    }

    const embedded = getPageEmbeddedVideoDetail(bvid);
    if (embedded) return embedded;

    throw new Error(
      '无法取得视频详情。公开接口失败：' +
      ((publicError && publicError.message) || publicError || '未知错误') +
      '。如果这是仅自己可见稿件，请确认当前浏览器已登录该视频的投稿账号。'
    );
  }

  async function fetchPlayerInfo(bvid, cid, aid = 0) {
    const attempts = [
      bvid ? { bvid, cid } : null,
      aid ? { aid, cid } : null,
    ].filter(Boolean);

    let lastJson = null;

    for (const params of attempts) {
      let json = await apiFetch('/x/player/v2', params);
      lastJson = json;
      if (json.code === 0 && json.data) return json.data;

      try {
        const keys = await getWbiKeys();
        const query = signWbi(params, keys.imgKey, keys.subKey);
        json = await apiFetch('/x/player/wbi/v2?' + query);
        lastJson = json;
        if (json.code === 0 && json.data) return json.data;
      } catch (err) {
        console.warn('[Bilibili章节导出] WBI 播放器接口失败：', err);
      }
    }

    throw new Error(
      ('获取播放器章节失败：' +
      (lastJson && lastJson.code !== undefined ? lastJson.code : 'unknown') + ' ' +
      ((lastJson && lastJson.message) || '')).trim()
    );
  }


  function secondsOfDuration(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? Math.max(0, value) : null;
    if (typeof value === 'string' && /^\d+(?::\d{1,2}){1,2}$/.test(value)) {
      return value.split(':').reduce((sum, value) => sum * 60 + Number(value), 0);
    }
    if (value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))) {
      return Math.max(0, Number(value));
    }
    return null;
  }

  function normalizeVideoParts(video, bvid) {
    const pages = Array.isArray(video.pages) && video.pages.length
      ? video.pages
      : (video.cid ? [{ cid: video.cid, page: 1, part: video.title, duration: video.duration }] : []);

    return pages.map((item, i) => {
      const page = Number(item.page || i + 1);
      const durationSeconds = secondsOfDuration(item.duration);
      return {
        page,
        title: String(item.part || item.title || ('P' + page)),
        cid: Number(item.cid || 0),
        duration_seconds: durationSeconds,
        duration: durationSeconds === null ? '' : formatClock(durationSeconds),
        url: 'https://www.bilibili.com/video/' + bvid + '?p=' + page,
      };
    });
  }

  function setPartCache(video, bvid) {
    const rows = normalizeVideoParts(video, bvid);
    if (!rows.length || !rows.some((row) => row.title)) return false;

    partRows = rows;
    partContext = {
      bvid,
      aid: video.aid || 0,
      title: video.title || document.title,
      source: location.href,
      detail_source: video._detail_source || '',
    };
    lastPartBvid = bvid;

    const viewBtn = document.querySelector('#bili-chapter-exporter .bae-view-parts');
    if (viewBtn) viewBtn.disabled = false;
    return true;
  }

  async function fetchPreferredPartDetail(bvid) {
    // 作者态返回完整的 videos[]，包括仅自己可见稿件的分 P 标题。
    try {
      const json = await memberApiFetch('/x/vupre/web/archive/view', {
        topic_grey: 1, bvid, t: Date.now(),
      });
      if (json.code === 0 && json.data) {
        const video = normalizeCreatorVideoDetail(json.data, bvid);
        if (video && video.pages.length) return video;

        // 少数作者态详情不带 videos[] 时，补查稿件分 P 列表。
        if (video && video.aid) {
          const fallback = await memberApiFetch('/x/web/archive/videos', { aid: video.aid });
          if (fallback.code === 0 && fallback.data) {
            const merged = normalizeCreatorVideoDetail({
              archive: { ...video, aid: video.aid },
              videos: fallback.data.videos || [],
            }, bvid);
            if (merged && merged.pages.length) return merged;
          }
        }
      }
    } catch (err) {
      console.warn('[Bilibili分P导出] 作者态详情失败，尝试公开视频详情：', err);
    }

    return fetchVideoDetail(bvid);
  }

  function partCsv(rows) {
    const lines = [['分P序号','分P标题','CID','时长','时长秒数','视频链接']];
    rows.forEach((row) => lines.push([
      row.page, row.title, row.cid, row.duration,
      row.duration_seconds == null ? '' : row.duration_seconds, row.url,
    ]));
    const esc = (cell) => '"' + String(cell == null ? '' : cell).replace(/"/g, '""') + '"';
    return '\ufeff' + lines.map((row) => row.map(esc).join(',')).join('\r\n');
  }

  function closePartDialog() {
    document.getElementById('bae-parts-overlay')?.remove();
  }

  function showPartDialog() {
    if (!partRows.length || !partContext || lastPartBvid !== getBvidFromUrl()) {
      setChapterStatus('还没有获取当前视频的分 P 列表，请先点击“获取分P”。');
      return;
    }
    closePartDialog();

    const overlay = document.createElement('div');
    overlay.id = 'bae-parts-overlay';
    overlay.innerHTML = `
      <div class="bae-parts-modal">
        <div class="bae-parts-head">
          <div>
            <div class="bae-parts-title">全部分 P 标题（${partRows.length}）</div>
            <div class="bae-parts-subtitle">${escapeHtml(partContext.title)} · ${escapeHtml(partContext.bvid)} · ${escapeHtml(partContext.detail_source)}</div>
          </div>
          <button class="bae-parts-close" type="button" title="关闭">×</button>
        </div>
        <div class="bae-parts-list">
          ${partRows.map((row) => `
            <div class="bae-parts-row">
              <span class="bae-parts-number">P${row.page}</span>
              <div class="bae-parts-main">
                <a href="${escapeHtml(row.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(row.title)}</a>
                <div class="bae-parts-meta">CID: ${row.cid || '未知'}${row.duration ? ' · ' + row.duration : ''}</div>
              </div>
            </div>
          `).join('')}
        </div>
        <div class="bae-parts-actions">
          <button type="button" class="bae-parts-copy">复制分 P 标题</button>
          <button type="button" class="bae-parts-json">导出 JSON</button>
          <button type="button" class="bae-parts-csv">导出 CSV</button>
          <button type="button" class="bae-parts-dismiss">关闭</button>
        </div>
      </div>
    `;

    overlay.style.cssText = [
      'position:fixed','inset:0','z-index:2147483647','display:flex',
      'align-items:center','justify-content:center','background:rgba(0,0,0,.48)',
      'padding:20px','box-sizing:border-box',
      'font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif',
    ].join(';');

    const style = document.createElement('style');
    style.textContent = `
      #bae-parts-overlay .bae-parts-modal {
        width:min(840px,96vw);height:min(750px,92vh);display:flex;flex-direction:column;
        background:#fff;color:#18191c;border-radius:12px;overflow:hidden;
        box-shadow:0 12px 42px rgba(0,0,0,.28)
      }
      #bae-parts-overlay .bae-parts-head {
        display:flex;align-items:flex-start;justify-content:space-between;
        gap:16px;padding:18px 20px;border-bottom:1px solid #e3e5e7
      }
      #bae-parts-overlay .bae-parts-title { font-size:18px;font-weight:700 }
      #bae-parts-overlay .bae-parts-subtitle { margin-top:5px;color:#61666d;overflow-wrap:anywhere }
      #bae-parts-overlay .bae-parts-list { flex:1;overflow:auto }
      #bae-parts-overlay .bae-parts-row {
        display:flex;align-items:center;gap:16px;padding:12px 20px;
        border-bottom:1px solid #f1f2f3
      }
      #bae-parts-overlay .bae-parts-row:hover { background:#f7f8f9 }
      #bae-parts-overlay .bae-parts-number { flex:none;width:48px;font-weight:700;color:#00aeec }
      #bae-parts-overlay .bae-parts-main { min-width:0 }
      #bae-parts-overlay .bae-parts-main a { color:#18191c;font-weight:600;text-decoration:none }
      #bae-parts-overlay .bae-parts-main a:hover { color:#00aeec }
      #bae-parts-overlay .bae-parts-meta { color:#9499a0;font-size:12px;margin-top:4px }
      #bae-parts-overlay .bae-parts-actions {
        display:flex;justify-content:flex-end;flex-wrap:wrap;gap:8px;
        padding:13px 20px;border-top:1px solid #e3e5e7
      }
      #bae-parts-overlay button {
        border:1px solid #c9ccd0;border-radius:6px;padding:7px 11px;
        background:#fff;color:#18191c;cursor:pointer;font-size:13px
      }
      #bae-parts-overlay .bae-parts-close {
        border:0;font-size:26px;line-height:1;color:#9499a0;padding:0
      }
      #bae-parts-overlay .bae-parts-json, #bae-parts-overlay .bae-parts-csv {
        background:#00aeec;color:#fff;border-color:#00aeec
      }
    `;
    overlay.appendChild(style);
    document.body.appendChild(overlay);

    const close = () => closePartDialog();
    overlay.querySelector('.bae-parts-close').addEventListener('click', close);
    overlay.querySelector('.bae-parts-dismiss').addEventListener('click', close);

    overlay.querySelector('.bae-parts-copy').addEventListener('click', async (event) => {
      const plain = partRows.map((row) => 'P' + row.page + ' ' + row.title).join('\n');
      const btn = event.currentTarget;
      try {
        await navigator.clipboard.writeText(plain);
      } catch (_) {
        const textarea = document.createElement('textarea');
        textarea.value = plain;
        textarea.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(textarea);
        textarea.select();
        const ok = document.execCommand('copy');
        textarea.remove();
        if (!ok) {
          setChapterStatus('复制失败，请检查浏览器剪贴板权限。');
          return;
        }
      }
      btn.textContent = '已复制';
    });

    const base = safeFilename(partContext.title + '_' + partContext.bvid + '_分P列表');
    const jsonOutput = () => ({
      exported_at: new Date().toISOString(),
      bvid: partContext.bvid,
      aid: partContext.aid,
      title: partContext.title,
      detail_source: partContext.detail_source,
      part_count: partRows.length,
      parts: partRows,
    });
    overlay.querySelector('.bae-parts-json').addEventListener('click', async () => {
      await downloadBlob(base + '.json', JSON.stringify(jsonOutput(), null, 2), 'application/json;charset=utf-8');
      setChapterStatus('已导出全部 ' + partRows.length + ' 个分 P 的 JSON。');
    });
    overlay.querySelector('.bae-parts-csv').addEventListener('click', async () => {
      await downloadBlob(base + '.csv', partCsv(partRows), 'text/csv;charset=utf-8');
      setChapterStatus('已导出全部 ' + partRows.length + ' 个分 P 的 CSV。');
    });
  }

  async function fetchCurrentVideoParts() {
    const bvid = getBvidFromUrl();
    if (!bvid) {
      setChapterStatus('没有从当前地址识别到 BV 号。');
      return;
    }
    const fetchBtn = document.querySelector('#bili-chapter-exporter .bae-fetch-parts');
    if (fetchBtn) fetchBtn.disabled = true;

    try {
      setChapterStatus(bvid + '\n正在获取完整分 P 列表及标题……');
      const video = await fetchPreferredPartDetail(bvid);
      if (getBvidFromUrl() !== bvid) return;
      if (!setPartCache(video, bvid)) throw new Error('稿件详情中没有可用的分 P 信息。');
      setChapterStatus('获取完成：共 ' + partRows.length + ' 个分 P，已读取标题。\n点击“查看分P”可反复预览、复制、导出，无需重新请求。');
      showPartDialog();
    } catch (err) {
      console.error('[Bilibili分P导出]', err);
      setChapterStatus('分 P 获取失败：' + (err?.message || err));
    } finally {
      if (fetchBtn) fetchBtn.disabled = false;
    }
  }

  function normalizeChapter(point, index) {
    const from = Number(point.from || 0);
    const to = Number(point.to || 0);
    return {
      index,
      title: point.content || '',
      from,
      to,
      start_time: formatClock(from),
      end_time: formatClock(to),
      duration_seconds: Math.max(0, Number((to - from).toFixed(3))),
      image_url: normalizeCover(point.imgUrl || point.img_url || ''),
      type: point.type ?? '',
      team_type: point.team_type ?? '',
      team_name: point.team_name ?? '',
      raw: point,
    };
  }

  function closeChapterDialog() {
    document.getElementById('bae-chapter-overlay')?.remove();
    document.getElementById('bae-chapter-style')?.remove();
  }

  function showChapterDialog(rows, context) {
    closeChapterDialog();

    const overlay = document.createElement('div');
    overlay.id = 'bae-chapter-overlay';
    overlay.innerHTML = `
      <div class="bae-chapter-modal">
        <div class="bae-chapter-header">
          <div>
            <div class="bae-chapter-title">视频章节</div>
            <div class="bae-chapter-summary">
              ${escapeHtml(context.title)}
              ${context.pageCount > 1 ? ` · P${context.pageNo}：${escapeHtml(context.partTitle)}` : ''}
              · 共 ${rows.length} 个章节
            </div>
          </div>
          <button class="bae-chapter-close" title="关闭">×</button>
        </div>

        <div class="bae-chapter-list">
          ${rows.map((row) => `
            <div class="bae-chapter-row">
              <div class="bae-chapter-index">${row.index}</div>
              <img class="bae-chapter-cover" src="${escapeHtml(row.image_url)}" loading="lazy" />
              <div class="bae-chapter-main">
                <div class="bae-chapter-name">${escapeHtml(row.title)}</div>
                <div class="bae-chapter-time">${escapeHtml(row.start_time)} → ${escapeHtml(row.end_time)} · ${row.duration_seconds}s</div>
              </div>
            </div>
          `).join('')}
        </div>

        <div class="bae-chapter-footer">
          <button class="bae-copy-chapters">复制章节文本</button>
          <button class="bae-export-chapter-json">导出 JSON</button>
          <button class="bae-export-chapter-csv">导出 CSV</button>
          <button class="bae-chapter-close-footer">关闭</button>
        </div>
      </div>
    `;

    const style = document.createElement('style');
    style.id = 'bae-chapter-style';
    style.textContent = `
      #bae-chapter-overlay {
        position: fixed; inset: 0; z-index: 2147483647; background: rgba(0,0,0,.48);
        display: flex; align-items: center; justify-content: center; padding: 24px; box-sizing: border-box;
        font: 14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;
      }
      #bae-chapter-overlay .bae-chapter-modal {
        width: min(900px,96vw); height: min(760px,92vh); background: #fff; color: #18191c;
        border-radius: 12px; box-shadow: 0 12px 42px rgba(0,0,0,.28);
        display: flex; flex-direction: column; overflow: hidden;
      }
      #bae-chapter-overlay .bae-chapter-header {
        display: flex; justify-content: space-between; gap: 16px; padding: 18px 20px 14px;
        border-bottom: 1px solid #e3e5e7;
      }
      #bae-chapter-overlay .bae-chapter-title { font-size: 18px; font-weight: 700; }
      #bae-chapter-overlay .bae-chapter-summary { margin-top: 5px; color: #61666d; }
      #bae-chapter-overlay .bae-chapter-close {
        border: 0; background: transparent; font-size: 26px; line-height: 1; cursor: pointer; color: #9499a0;
      }
      #bae-chapter-overlay .bae-chapter-list { flex: 1; overflow: auto; }
      #bae-chapter-overlay .bae-chapter-row {
        display: grid; grid-template-columns: 42px 128px minmax(0,1fr);
        gap: 12px; align-items: center; padding: 12px 20px; border-bottom: 1px solid #f1f2f3;
      }
      #bae-chapter-overlay .bae-chapter-row:hover { background: #fafafa; }
      #bae-chapter-overlay .bae-chapter-index { color: #9499a0; text-align: center; }
      #bae-chapter-overlay .bae-chapter-cover {
        width: 128px; height: 72px; border-radius: 6px; object-fit: cover; background: #eee;
      }
      #bae-chapter-overlay .bae-chapter-name { font-size: 15px; font-weight: 600; }
      #bae-chapter-overlay .bae-chapter-time { margin-top: 6px; color: #9499a0; font-size: 12px; }
      #bae-chapter-overlay .bae-chapter-footer {
        display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap;
        padding: 13px 20px; border-top: 1px solid #e3e5e7;
      }
      #bae-chapter-overlay .bae-chapter-footer button {
        border: 1px solid #c9ccd0; border-radius: 6px; padding: 7px 11px; background: #fff; cursor: pointer;
      }
      #bae-chapter-overlay .bae-export-chapter-json,
      #bae-chapter-overlay .bae-export-chapter-csv {
        background: #00aeec !important; color: #fff; border-color: #00aeec !important;
      }
    `;

    document.documentElement.appendChild(style);
    document.body.appendChild(overlay);

    const close = () => closeChapterDialog();
    overlay.querySelector('.bae-chapter-close').addEventListener('click', close);
    overlay.querySelector('.bae-chapter-close-footer').addEventListener('click', close);

    overlay.querySelector('.bae-copy-chapters').addEventListener('click', async (event) => {
      const text = rows.map((row) => `${row.start_time} ${row.title}`).join('\n');
      const button = event.currentTarget;
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = '已复制';
        setTimeout(() => { button.textContent = '复制章节文本'; }, 1200);
      } catch (err) {
        console.warn('[Bilibili章节导出] 剪贴板写入失败：', err);
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        textarea.remove();
        button.textContent = '已复制';
        setTimeout(() => { button.textContent = '复制章节文本'; }, 1200);
      }
    });

    const buildOutput = () => ({
      exported_at: new Date().toISOString(),
      bvid: context.bvid,
      aid: context.aid,
      cid: context.cid,
      title: context.title,
      page_no: context.pageNo,
      page_count: context.pageCount,
      part_title: context.partTitle,
      source: context.source,
      chapter_count: rows.length,
      chapters: rows,
    });

    const base = safeFilename(
      `${context.title}_${context.bvid}${context.pageCount > 1 ? `_P${context.pageNo}` : ''}_章节`
    );

    overlay.querySelector('.bae-export-chapter-json').addEventListener('click', async () => {
      await downloadBlob(
        `${base}.json`,
        JSON.stringify(buildOutput(), null, 2),
        'application/json;charset=utf-8'
      );
      setChapterStatus(`已导出 ${rows.length} 个章节的 JSON。`);
    });

    overlay.querySelector('.bae-export-chapter-csv').addEventListener('click', async () => {
      await downloadBlob(
        `${base}.csv`,
        toChapterCsv(rows),
        'text/csv;charset=utf-8'
      );
      setChapterStatus(`已导出 ${rows.length} 个章节的 CSV。`);
    });
  }

  function setChapterStatus(text) {
    const el = document.querySelector('#bili-chapter-exporter .bae-chapter-status');
    if (el) el.textContent = text;
  }

  function createChapterUi() {
    if (document.getElementById('bili-chapter-exporter')) return;

    const root = document.createElement('div');
    root.id = 'bili-chapter-exporter';
    root.innerHTML = `
      <div class="bae-chapter-panel-title">视频分 P / 章节导出</div>
      <div class="bae-chapter-status">分 P 标题和播放器章节是两种不同的信息。</div>
      <div class="bae-chapter-actions">
        <button class="bae-fetch-parts">获取分P</button>
        <button class="bae-view-parts" disabled>查看分P</button>
      </div>
      <div class="bae-chapter-actions">
        <button class="bae-fetch-chapter">获取章节</button>
        <button class="bae-view-chapter" disabled>再次查看章节</button>
      </div>
    `;

    const style = document.createElement('style');
    style.id = 'bae-chapter-panel-style';
    style.textContent = `
      #bili-chapter-exporter {
        position: fixed; right: 20px; bottom: 24px; z-index: 2147483646;
        width: 300px; padding: 14px; box-sizing: border-box;
        background: rgba(255,255,255,.97); color: #18191c;
        border: 1px solid #e3e5e7; border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.16);
        font: 14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;
      }
      #bili-chapter-exporter .bae-chapter-panel-title { font-weight: 700; margin-bottom: 7px; }
      #bili-chapter-exporter .bae-chapter-status {
        min-height: 42px; color: #61666d; white-space: pre-wrap; word-break: break-word;
      }
      #bili-chapter-exporter .bae-chapter-actions { display: flex; gap: 8px; margin-top: 10px; }
      #bili-chapter-exporter button {
        flex: 1; border: 0; border-radius: 6px; padding: 7px 10px; cursor: pointer; font-size: 13px;
      }
      #bili-chapter-exporter .bae-fetch-chapter { background: #00aeec; color: #fff; }
      #bili-chapter-exporter .bae-view-chapter { background: #00b578; color: #fff; }
      #bili-chapter-exporter button:disabled { opacity: .5; cursor: not-allowed; }
    `;

    document.documentElement.appendChild(style);
    document.body.appendChild(root);

    root.querySelector('.bae-fetch-parts').addEventListener('click', fetchCurrentVideoParts);
    root.querySelector('.bae-view-parts').addEventListener('click', showPartDialog);
    root.querySelector('.bae-fetch-chapter').addEventListener('click', fetchCurrentVideoChapters);
    root.querySelector('.bae-view-chapter').addEventListener('click', () => {
      if (chapterRows.length && chapterContext) showChapterDialog(chapterRows, chapterContext);
    });
  }

  async function fetchCurrentVideoChapters() {
    const bvid = getBvidFromUrl();
    if (!bvid) {
      setChapterStatus('没有从当前网址识别到 BV 号。');
      return;
    }

    const fetchBtn = document.querySelector('#bili-chapter-exporter .bae-fetch-chapter');
    const viewBtn = document.querySelector('#bili-chapter-exporter .bae-view-chapter');
    if (fetchBtn) fetchBtn.disabled = true;
    if (viewBtn) viewBtn.disabled = true;

    try {
      setChapterStatus(`${bvid}\n正在验证当前 B 站登录态……`);
      let loginState = null;
      try {
        loginState = await getBilibiliLoginState();
        if (loginState.isLogin) {
          setChapterStatus(
            `${bvid}\n已登录：${loginState.uname || loginState.mid}（UID ${loginState.mid}）\n正在读取视频信息……`
          );
        } else {
          setChapterStatus(`${bvid}\n当前请求未识别到 B 站登录态，仍尝试读取视频信息……`);
        }
      } catch (err) {
        console.warn('[Bilibili章节导出] 登录态检查失败：', err);
        setChapterStatus(`${bvid}\n登录态检查失败，仍尝试读取视频信息……`);
      }

      const video = await fetchVideoDetail(bvid);
      if (getBvidFromUrl() !== bvid) return;
      setPartCache(video, bvid);
      const pageNo = Math.min(getCurrentVideoPageNo(), Math.max(1, video.pages?.length || 1));
      const pageInfo = video.pages?.find((p) => Number(p.page) === pageNo) || video.pages?.[pageNo - 1] || {
        cid: video.cid,
        page: 1,
        part: video.title,
      };

      if (!pageInfo?.cid) throw new Error('没有找到当前分 P 的 CID。');

      setChapterStatus(
        `${bvid} · P${pageNo}\n视频详情来源：${video._detail_source || 'unknown'}\n正在读取章节信息……`
      );
      const player = await fetchPlayerInfo(bvid, pageInfo.cid, video.aid);
      const points = Array.isArray(player.view_points) ? player.view_points : [];
      const rows = points.map((point, i) => normalizeChapter(point, i + 1));

      const currentKey = `${bvid}:p${pageNo}`;
      lastVideoKey = currentKey;
      chapterRows = rows;
      chapterContext = {
        bvid,
        aid: video.aid,
        cid: pageInfo.cid,
        title: video.title || document.title,
        pageNo,
        pageCount: video.pages?.length || 1,
        partTitle: pageInfo.part || '',
        source: location.href,
        detailSource: video._detail_source || '',
        loginMid: Number(player.login_mid || (loginState && loginState.mid) || 0),
        isOwner: Boolean(player.is_owner),
      };

      if (!rows.length) {
        setChapterStatus(
          `${bvid} · P${pageNo}\n此 P 没有返回播放器章节/看点。\n${partRows.length ? '已经取得 ' + partRows.length + ' 个分 P 的标题，可点击“查看分P”。' : '可以另行点击“获取分P”读取分 P 标题。'}\n登录 UID：${player.login_mid || (loginState && loginState.mid) || '未知'} · is_owner=${Boolean(player.is_owner)}`
        );
        return;
      }

      const ownerText = player.is_owner ? ' · 已确认作者身份' : '';
      setChapterStatus(
        `获取完成：${rows.length} 个章节${ownerText}。\n登录 UID：${player.login_mid || (loginState && loginState.mid) || '未知'}\n可点击“再次查看”重复打开，无需重新请求。`
      );
      if (viewBtn) viewBtn.disabled = false;
      showChapterDialog(chapterRows, chapterContext);
    } catch (err) {
      console.error('[Bilibili章节导出]', err);
      setChapterStatus(`失败：${err?.message || err}`);
    } finally {
      if (fetchBtn) fetchBtn.disabled = false;
    }
  }

  function ensureChapterUiForCurrentPage() {
    const bvid = getBvidFromUrl();
    if (!bvid) return;

    createChapterUi();

    if (lastPartBvid && lastPartBvid !== bvid) {
      partRows = [];
      partContext = null;
      lastPartBvid = null;
      closePartDialog();
      const partButton = document.querySelector('#bili-chapter-exporter .bae-view-parts');
      if (partButton) partButton.disabled = true;
    }

    const key = bvid + ':p' + getCurrentVideoPageNo();
    if (lastVideoKey && key !== lastVideoKey) {
      chapterRows = [];
      chapterContext = null;
      lastVideoKey = null;
      const viewBtn = document.querySelector('#bili-chapter-exporter .bae-view-chapter');
      if (viewBtn) viewBtn.disabled = true;
      setChapterStatus('当前视频/分 P 已变化。分 P 列表可继续复用，章节需重新获取。');
    }
  }

  function ensureUiForCurrentPage() {
    const uid = getUidFromUrl();
    if (!uid) return;
    if (uid !== lastUid) lastUid = uid;
    createUi();
  }

  ensureUiForCurrentPage();
  ensureChapterUiForCurrentPage();
  setInterval(() => {
    ensureUiForCurrentPage();
    ensureChapterUiForCurrentPage();
  }, 1500);
})();
