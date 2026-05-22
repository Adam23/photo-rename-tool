/**
 * rename.js - 文件名提取与重命名逻辑
 * 管理识别结果，生成新的文件名，支持手动编辑
 */

const Rename = (() => {
  // 存储所有识别结果
  let entries = [];

  /**
   * 根据 OCR 结果创建条目
   * @param {File} file - 原始文件
   * @param {object} ocrResult - OCR 识别结果
   * @returns {object} 条目对象
   */
  function createEntry(file, ocrResult) {
    const ext = file.name.split('.').pop() || 'png';
    const baseName = file.name.replace(/\.[^.]+$/, '');
    const managerName = ocrResult.name || '';

    return {
      id: Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      file,
      originalName: file.name,
      extension: ext,
      baseName,
      managerName,
      newName: managerName ? `${managerName}.${ext}` : file.name,
      ocrText: ocrResult.text || '',
      ocrFullText: ocrResult.fullText || '',
      success: !!managerName,
      edited: false,
      confirmed: !!managerName,
    };
  }

  /**
   * 批量创建条目
   * @param {Array} ocrResults - OCR 识别结果数组 [{file, name, text, ...}, ...]
   * @returns {Array} 条目数组
   */
  function createEntries(ocrResults) {
    entries = ocrResults.map((result) => createEntry(result.file, result));
    return entries;
  }

  /**
   * 更新某一条目的新文件名
   * @param {string} id - 条目 ID
   * @param {string} newName - 新的文件名（不含扩展名会自动补上）
   */
  function updateEntry(id, newName) {
    const entry = entries.find((e) => e.id === id);
    if (!entry) return;

    // 如果用户输入的名字不包含扩展名，自动补上
    const hasExtension = /\.[a-zA-Z0-9]{2,5}$/.test(newName.trim());
    if (!hasExtension) {
      newName = `${newName.trim()}.${entry.extension}`;
    }

    entry.newName = newName.trim();
    entry.edited = true;
    entry.confirmed = true;
    return entry;
  }

  /**
   * 获取所有条目
   */
  function getEntries() {
    return entries;
  }

  /**
   * 获取已确认的条目（名字已确定）
   */
  function getConfirmedEntries() {
    return entries.filter((e) => e.confirmed);
  }

  /**
   * 获取未确认的条目
   */
  function getUnconfirmedEntries() {
    return entries.filter((e) => !e.confirmed);
  }

  /**
   * 清除所有条目
   */
  function clearAll() {
    entries = [];
  }

  /**
   * 获取统计信息
   */
  function getStats() {
    const total = entries.length;
    const confirmed = getConfirmedEntries().length;
    const success = entries.filter((e) => e.success).length;
    return { total, confirmed, success };
  }

  /**
   * 检查是否有重名
   * @returns {object[]} 重名冲突列表 [{name, entries}]
   */
  function findConflicts() {
    const nameMap = new Map();
    entries.forEach((entry) => {
      if (!nameMap.has(entry.newName)) {
        nameMap.set(entry.newName, []);
      }
      nameMap.get(entry.newName).push(entry);
    });

    const conflicts = [];
    nameMap.forEach((group, name) => {
      if (group.length > 1) {
        conflicts.push({ name, entries: group });
      }
    });
    return conflicts;
  }

  /**
   * 自动解决重名冲突：在重名文件后加数字后缀
   */
  function resolveConflicts() {
    const conflicts = findConflicts();
    conflicts.forEach(({ entries: group }) => {
      group.forEach((entry, idx) => {
        if (idx > 0) {
          const ext = entry.extension;
          const base = entry.newName.replace(/\.[^.]+$/, '');
          entry.newName = `${base}_${idx + 1}.${ext}`;
        }
      });
    });
    return conflicts.length;
  }

  return {
    createEntries,
    updateEntry,
    getEntries,
    getConfirmedEntries,
    getUnconfirmedEntries,
    clearAll,
    getStats,
    findConflicts,
    resolveConflicts,
  };
})();

if (typeof window !== 'undefined') {
  window.Rename = Rename;
}
