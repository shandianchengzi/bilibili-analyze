// ==UserScript==
// @name         Bilibili UP主全部公开视频导出
// @namespace    https://space.bilibili.com/
// @version      1.1.0
// @description  获取B站UP主全部公开投稿，按合集状态筛选、勾选后导出CSV/JSON。
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
  let fetchedRows = [];
  let exportContext = null;

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
  }

  function showSelectionDialog(rows, context) {
    closeSelectionDialog();

    const selected = new Set(
      rows.filter((row) => !row.season_id).map((row) => String(row.bvid || row.aid))
    );

    const overlay = document.createElement('div');
    overlay.id = 'bae-selection-overlay';
    overlay.innerHTML = \`
      <div class="bae-modal">
        <div class="bae-modal-header">
          <div>
            <div class="bae-modal-title">选择要导出的视频</div>
            <div class="bae-modal-summary">
              共 \${rows.length} 个投稿，其中未加入合集
              <strong>\${rows.filter((r) => !r.season_id).length}</strong> 个。
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
    \`;

    const style = document.createElement('style');
    style.id = 'bae-selection-style';
    style.textContent = \`
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
    \`;
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
      visibleCountEl.textContent = \`当前显示 \${visibleRows.length} 个\`;
      selectedCountEl.textContent = \`已选 \${selected.size} 个\`;
      exportBtn.disabled = selected.size === 0;
      exportBtn.textContent = selected.size ? \`导出已选视频（\${selected.size}）\` : '导出已选视频';
    }

    function render() {
      const visibleRows = getVisibleRows();
      listEl.innerHTML = visibleRows.map((row) => {
        const key = keyOf(row);
        const checked = selected.has(key) ? 'checked' : '';
        const collection = row.season_id
          ? \`<span>合集：\${escapeHtml(row.season_title || String(row.season_id))}</span>\`
          : '<span class="bae-no-season">未加入合集</span>';
        return \`
          <label class="bae-row">
            <input class="bae-check" type="checkbox" data-key="\${escapeHtml(key)}" \${checked} />
            <img class="bae-cover" src="\${escapeHtml(row.cover)}" loading="lazy" />
            <div>
              <a class="bae-video-title" href="\${escapeHtml(row.url)}" target="_blank" rel="noopener noreferrer">
                \${escapeHtml(row.title)}
              </a>
              <div class="bae-meta">\${escapeHtml(row.publish_time)} · \${escapeHtml(row.duration)} · \${escapeHtml(row.bvid)}</div>
            </div>
            <div class="bae-season">\${collection}</div>
          </label>
        \`;
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
          \`\${context.author}_\${context.uid}_\${suffix}_\${new Date().toISOString().slice(0, 10)}\`
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
          \`\${base}.json\`,
          JSON.stringify(jsonOutput, null, 2),
          'application/json;charset=utf-8'
        );
        await sleep(250);
        await downloadBlob(\`\${base}.csv\`, toCsv(chosen), 'text/csv;charset=utf-8');

        setStatus(\`已导出 \${chosen.length} 个视频。\`);
        closeSelectionDialog();
      } catch (err) {
        console.error('[Bilibili投稿导出]', err);
        alert(\`导出失败：\${err?.message || err}\`);
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
      const uncollectedCount = rows.filter((row) => !row.season_id).length;

      fetchedRows = rows;
      exportContext = {
        uid,
        author,
        reportedTotal: total,
        source: location.href,
      };

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

  function ensureUiForCurrentPage() {
    const uid = getUidFromUrl();
    if (!uid) return;
    if (uid !== lastUid) lastUid = uid;
    createUi();
  }

  ensureUiForCurrentPage();
  setInterval(ensureUiForCurrentPage, 1500);
})();
