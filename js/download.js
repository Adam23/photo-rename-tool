/**
 * download.js - JSZip 打包下载逻辑
 * 支持单文件直接下载，多文件打包为 ZIP
 */

const Download = (() => {
  /**
   * 单文件下载
   * @param {File} file - 要下载的文件
   * @param {string} filename - 目标文件名
   */
  function downloadSingle(file, filename) {
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /**
   * 从 File 对象读取为 ArrayBuffer
   * @param {File} file
   * @returns {Promise<ArrayBuffer>}
   */
  function readFileAsBuffer(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsArrayBuffer(file);
    });
  }

  /**
   * 批量打包下载（ZIP）
   * @param {object[]} entries - Rename.getEntries() 的结果
   * @param {function} onProgress - 进度回调 (current, total)
   * @returns {Promise<Blob>} ZIP Blob
   */
  async function downloadBatchAsZip(entries, onProgress) {
    const confirmed = entries.filter((e) => e.confirmed);
    const zip = new JSZip();

    // 先解决重名冲突
    const nameCount = {};
    const assignedNames = new Map();

    confirmed.forEach((entry) => {
      let newName = entry.newName || entry.file.name;

      // 检查重名
      if (nameCount[newName] !== undefined) {
        nameCount[newName]++;
        // 在扩展名之前插入数字
        const dotIndex = newName.lastIndexOf('.');
        if (dotIndex > 0) {
          newName = newName.slice(0, dotIndex) + '_' + nameCount[newName] + newName.slice(dotIndex);
        } else {
          newName = newName + '_' + nameCount[newName];
        }
      } else {
        nameCount[newName] = 0;
      }
      assignedNames.set(entry.id, newName);
    });

    for (let i = 0; i < confirmed.length; i++) {
      const entry = confirmed[i];
      const newName = assignedNames.get(entry.id) || entry.newName;

      try {
        const buffer = await readFileAsBuffer(entry.file);
        zip.file(newName, buffer, { binary: true });
      } catch (err) {
        console.error(`打包失败: ${entry.originalName}`, err);
      }

      onProgress && onProgress(i + 1, confirmed.length);
    }

    return await zip.generateAsync({ type: 'blob' });
  }

  /**
   * 触发浏览器下载 Blob
   * @param {Blob} blob
   * @param {string} filename
   */
  function saveBlob(blob, filename) {
    if (typeof saveAs !== 'undefined') {
      saveAs(blob, filename);
    } else {
      // Fallback
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  }

  /**
   * 一键批量下载
   * @param {object[]} entries - 条目列表
   * @param {function} onProgress - (current, total, stage)
   */
  async function batchDownload(entries, onProgress) {
    const confirmed = entries.filter((e) => e.confirmed);

    if (confirmed.length === 0) {
      throw new Error('没有已确认的文件可下载');
    }

    if (confirmed.length === 1) {
      // 单文件直接下载
      const entry = confirmed[0];
      downloadSingle(entry.file, entry.newName);
      onProgress && onProgress(1, 1, 'done');
      return;
    }

    // 多文件打包 ZIP
    onProgress && onProgress(0, confirmed.length, 'packing');
    const blob = await downloadBatchAsZip(entries, (current, total) => {
      onProgress && onProgress(current, total, 'packing');
    });

    onProgress && onProgress(confirmed.length, confirmed.length, 'saving');
    const timestamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    saveBlob(blob, `重命名图片_${timestamp}.zip`);
    onProgress && onProgress(confirmed.length, confirmed.length, 'done');
  }

  /**
   * 获取文件大小可读格式
   */
  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }

  return {
    downloadSingle,
    batchDownload,
    saveBlob,
    formatSize,
  };
})();

if (typeof window !== 'undefined') {
  window.Download = Download;
}
