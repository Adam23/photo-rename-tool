/**
 * ui.js - 界面交互逻辑
 * 连接 OCR、Rename、Download 模块，驱动 UI
 */

const App = (() => {
  // DOM 引用缓存
  let els = {};

  // 状态
  let uploadedFiles = [];
  let isProcessing = false;
  let lastOcrResults = []; // 保存最近一次 OCR 结果用于调试

  /**
   * 缓存 DOM 引用
   */
  function cacheDOMElements() {
    els = {
      fileInput: document.getElementById('fileInput'),
      uploadZone: document.getElementById('uploadZone'),
      previewGrid: document.getElementById('previewGrid'),
      emptyState: document.getElementById('emptyState'),
      resultsSection: document.getElementById('resultsSection'),
      resultsList: document.getElementById('resultsList'),
      resultCount: document.getElementById('resultCount'),
      progressContainer: document.getElementById('progressContainer'),
      progressFill: document.getElementById('progressFill'),
      progressText: document.getElementById('progressText'),
      progressCount: document.getElementById('progressCount'),
      btnStartOCR: document.getElementById('btnStartOCR'),
      btnDownload: document.getElementById('btnDownload'),
      btnClear: document.getElementById('btnClear'),
      toast: document.getElementById('toast'),
      debugPanel: document.getElementById('debugPanel'),
      debugContent: document.getElementById('debugContent'),
    };
  }

  /**
   * Toast 提示
   */
  function showToast(message, duration = 2500) {
    els.toast.textContent = message;
    els.toast.classList.add('visible');
    clearTimeout(els.toast._timeout);
    els.toast._timeout = setTimeout(() => {
      els.toast.classList.remove('visible');
    }, duration);
  }

  /**
   * 显示/隐藏进度条
   */
  function setProgress(visible, percent = 0, text = '') {
    if (visible) {
      els.progressContainer.classList.add('visible');
      els.progressFill.style.width = percent + '%';
      els.progressText.textContent = text;
    } else {
      els.progressContainer.classList.remove('visible');
      els.progressFill.style.width = '0%';
    }
  }

  /**
   * 更新进度计数
   */
  function setProgressCount(current, total) {
    els.progressCount.textContent = `${current} / ${total}`;
  }

  /**
   * 处理文件选择
   */
  function handleFiles(files) {
    if (!files || files.length === 0) return;

    uploadedFiles = Array.from(files).filter((f) => f.type.startsWith('image/'));
    if (uploadedFiles.length === 0) {
      showToast('请选择图片文件');
      return;
    }

    renderPreviews();
    updateActions();
  }

  /**
   * 渲染图片预览网格
   */
  function renderPreviews() {
    els.previewGrid.innerHTML = '';
    els.emptyState.classList.remove('visible');

    if (uploadedFiles.length === 0) {
      els.emptyState.classList.add('visible');
      return;
    }

    uploadedFiles.forEach((file, index) => {
      const item = document.createElement('div');
      item.className = 'preview-item';
      item.dataset.index = index;

      const img = document.createElement('img');
      img.alt = file.name;

      const reader = new FileReader();
      reader.onload = (e) => {
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);

      const overlay = document.createElement('div');
      overlay.className = 'overlay';
      overlay.innerHTML = `<span class="file-name">${file.name}</span>`;

      const badge = document.createElement('span');
      badge.className = 'status-badge pending';
      badge.textContent = '待识别';

      item.appendChild(img);
      item.appendChild(overlay);
      item.appendChild(badge);
      els.previewGrid.appendChild(item);
    });
  }

  /**
   * 更新预览中的状态徽章
   */
  function updatePreviewBadge(index, status) {
    const items = els.previewGrid.querySelectorAll('.preview-item');
    if (items[index]) {
      const badge = items[index].querySelector('.status-badge');
      if (badge) {
        badge.className = 'status-badge ' + status;
        badge.textContent = status === 'done' ? '✓' : status === 'processing' ? '识别中' : '待识别';
      }
    }
  }

  /**
   * 更新按钮状态
   */
  function updateActions() {
    const hasFiles = uploadedFiles.length > 0;
    const entries = Rename.getEntries();
    const hasResults = entries.length > 0;
    const hasConfirmed = entries.some((e) => e.confirmed);

    els.btnStartOCR.disabled = !hasFiles || isProcessing;
    els.btnDownload.disabled = !hasConfirmed || isProcessing;
    els.btnClear.disabled = !hasFiles || isProcessing;

    els.btnStartOCR.style.display = hasFiles ? '' : 'none';
    els.btnClear.style.display = hasFiles ? '' : 'none';
    els.btnDownload.style.display = hasConfirmed ? '' : 'none';
  }

  /**
   * 渲染识别结果
   */
  function renderResults() {
    const entries = Rename.getEntries();
    if (entries.length === 0) {
      els.resultsSection.classList.remove('visible');
      return;
    }

    const stats = Rename.getStats();
    els.resultCount.textContent = `${stats.confirmed}/${stats.total}`;
    els.resultsSection.classList.add('visible');

    els.resultsList.innerHTML = '';

    entries.forEach((entry) => {
      const row = document.createElement('div');
      row.className = 'result-row';

      // 缩略图
      const thumb = document.createElement('img');
      thumb.className = 'thumb';
      thumb.alt = entry.originalName;
      const reader = new FileReader();
      reader.onload = (e) => { thumb.src = e.target.result; };
      reader.readAsDataURL(entry.file);

      // 信息区
      const info = document.createElement('div');
      info.className = 'info';

      const origName = document.createElement('div');
      origName.className = 'original-name';
      origName.textContent = entry.originalName;

      const wrap = document.createElement('div');
      wrap.className = 'new-name-wrap';

      const arrow = document.createElement('span');
      arrow.className = 'arrow';

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'new-name-input';
      input.value = entry.newName || '';
      input.placeholder = entry.success ? '' : '手动输入名字';
      input.dataset.entryId = entry.id;

      // 自动识别成功的用红色边框提示
      if (entry.success && !entry.edited) {
        input.style.borderColor = 'var(--red)';
      }

      input.addEventListener('input', () => {
        Rename.updateEntry(entry.id, input.value);
        updateActions();
      });

      input.addEventListener('blur', () => {
        Rename.updateEntry(entry.id, input.value);
        if (entry.success && input.value !== `${entry.managerName}.${entry.extension}`) {
          input.style.borderColor = 'var(--border)';
        }
        updateActions();
      });

      wrap.appendChild(arrow);
      wrap.appendChild(input);
      info.appendChild(origName);
      info.appendChild(wrap);

      row.appendChild(thumb);
      row.appendChild(info);
      els.resultsList.appendChild(row);
    });
  }

  /**
   * 开始 OCR 识别
   */
  async function startOCR() {
    if (uploadedFiles.length === 0) return;
    if (isProcessing) return;

    isProcessing = true;
    updateActions();

    // 初始化 OCR 引擎
    setProgress(true, 0, '正在加载 OCR 引擎...');
    showToast('正在加载 OCR 引擎，首次加载需要下载约 10MB 数据...', 4000);

    try {
      await OCR.init((info) => {
        if (info.status === 'loading') {
          setProgress(true, Math.round(info.progress * 100), info.message);
        } else if (info.status === 'ready') {
          setProgress(true, 100, '引擎就绪，开始识别...');
        }
      });

      // 批量识别
      showToast(`开始识别 ${uploadedFiles.length} 张图片...`);
      setProgressCount(0, uploadedFiles.length);

      const results = await OCR.recognizeBatch(uploadedFiles, (current, total, result) => {
        setProgressCount(current, total);
        setProgress(true, Math.round((current / total) * 100), `识别中 ${current}/${total}`);
        updatePreviewBadge(result.index, result.success ? 'done' : 'done');
      });

      // 保存原始结果用于调试
      lastOcrResults = results;

      // 创建重命名条目
      Rename.createEntries(results);

      // 渲染结果
      renderResults();
      renderDebug(results);
      updateActions();

      const stats = Rename.getStats();
      const failedCount = stats.total - stats.success;
      if (failedCount > 0) {
        showToast(`识别完成！成功 ${stats.success}/${stats.total}，${failedCount} 张失败。点击下方「🔍 OCR 调试信息」查看原因`);
      } else {
        showToast(`识别完成！成功识别 ${stats.success}/${stats.total} 个名字`);
      }

    } catch (err) {
      console.error('OCR 处理失败:', err);
      showToast('识别失败：' + err.message, 3000);
    } finally {
      isProcessing = false;
      setProgress(false);
      updateActions();
    }
  }

  /**
   * 一键下载
   */
  async function startDownload() {
    const entries = Rename.getEntries();
    if (entries.length === 0) return;

    try {
      setProgress(true, 0, '正在打包...');
      setProgressCount(0, entries.filter((e) => e.confirmed).length);

      await Download.batchDownload(entries, (current, total, stage) => {
        setProgressCount(current, total);
        if (stage === 'packing') {
          setProgress(true, Math.round((current / total) * 100), '正在打包...');
        } else if (stage === 'saving') {
          setProgress(true, 100, '正在保存...');
        }
      });

      showToast('下载完成！');

    } catch (err) {
      console.error('下载失败:', err);
      showToast('下载失败：' + err.message, 3000);
    } finally {
      setProgress(false);
    }
  }

  /**
   * 渲染 OCR 调试面板
   */
  function renderDebug(results) {
    // 始终显示调试面板
    els.debugPanel.style.display = 'block';

    let html = '';
    results.forEach((r, i) => {
      const icon = r.success ? '✅' : '❌';
      html += `<div class="debug-entry">`;
      html += `<div class="debug-label">${icon} ${r.file.name}</div>`;

      // 成功信息
      if (r.success) {
        html += `<div style="color:#2E7D32;font-size:0.8rem;margin:4px 0;">`;
        html += `识别结果: <strong>${r.name}</strong>`;
        if (r.debug && r.debug.attempts) {
          const hitAttempt = r.debug.attempts.find(a => a.name);
          if (hitAttempt) {
            html += ` <span style="font-size:0.7rem;color:var(--border);">(策略: ${hitAttempt.label}, 方法: ${hitAttempt.method})</span>`;
          }
        }
        html += `</div>`;
      }

      if (r.error) {
        html += `<div class="debug-error">错误: ${r.error}</div>`;
      } else if (r.debug && r.debug.attempts) {
        // 只显示未命中或命中策略的详情
        r.debug.attempts.forEach((a, j) => {
          const isHit = a.name && a.name === r.name;
          const bgColor = isHit ? 'rgba(46,125,50,0.08)' : 'transparent';
          html += `<div style="font-size:0.7rem;color:var(--border);margin:6px 0 2px;background:${bgColor};padding:2px 4px;border-radius:2px;">`;
          html += `[${a.label}]`;
          if (a.method) {
            html += ` 方法:${a.method}`;
          }
          if (isHit) {
            html += ` <span style="color:#2E7D32;">★ 命中</span>`;
          }
          html += `</div>`;
          if (a.text) {
            html += `<div class="debug-text">${a.text || '（空）'}</div>`;
          }
          if (a.error) {
            html += `<div class="debug-error">${a.error}</div>`;
          }
        });
      } else {
        html += `<div class="debug-text">${r.fullText || '（未识别到文字）'}</div>`;
      }
      if (!r.success) {
        html += `<div style="color:var(--red);font-size:0.75rem;margin-top:4px;">⚠ 所有策略均未识别到人名</div>`;
      }
      html += `</div>`;
      html += `<hr style="border-color:var(--border);opacity:0.3;margin:8px 0;">`;
    });
    els.debugContent.innerHTML = html;
  }

  /**
   * 清除所有
   */
  function clearAll() {
    uploadedFiles = [];
    Rename.clearAll();
    els.fileInput.value = '';
    els.previewGrid.innerHTML = '';
    els.resultsList.innerHTML = '';
    els.resultsSection.classList.remove('visible');
    els.emptyState.classList.add('visible');
    els.debugPanel.style.display = 'none';
    lastOcrResults = [];
    updateActions();
    setProgress(false);
    showToast('已清除全部');
  }

  /**
   * 初始化事件监听
   */
  function initEvents() {
    // 上传区域 - 点击
    els.uploadZone.addEventListener('click', () => {
      if (!isProcessing) {
        els.fileInput.click();
      }
    });

    // 文件选择
    els.fileInput.addEventListener('change', (e) => {
      handleFiles(e.target.files);
    });

    // 拖拽上传
    els.uploadZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      els.uploadZone.classList.add('drag-over');
    });

    els.uploadZone.addEventListener('dragleave', () => {
      els.uploadZone.classList.remove('drag-over');
    });

    els.uploadZone.addEventListener('drop', (e) => {
      e.preventDefault();
      els.uploadZone.classList.remove('drag-over');
      handleFiles(e.dataTransfer.files);
    });

    // 按钮
    els.btnStartOCR.addEventListener('click', startOCR);
    els.btnDownload.addEventListener('click', startDownload);
    els.btnClear.addEventListener('click', clearAll);

    // 移动端：触摸时给上传区域反馈
    els.uploadZone.addEventListener('touchstart', () => {
      els.uploadZone.style.borderColor = 'var(--red)';
    });
    els.uploadZone.addEventListener('touchend', () => {
      els.uploadZone.style.borderColor = '';
    });
  }

  /**
   * 应用启动
   */
  function init() {
    cacheDOMElements();

    // 检查必要依赖是否加载
    if (typeof Tesseract === 'undefined') {
      els.uploadZone.innerHTML = '<div style="padding:32px;color:#E4422E">OCR 引擎加载失败，请刷新页面重试</div>';
      console.error('Tesseract.js 未加载');
      return;
    }
    if (typeof JSZip === 'undefined') {
      console.warn('JSZip 未加载，打包下载功能可能不可用');
    }

    // 初始显示空状态
    els.emptyState.classList.add('visible');
    updateActions();

    initEvents();
  }

  return { init };
})();

// 页面加载完成后初始化
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => App.init());
} else {
  App.init();
}
