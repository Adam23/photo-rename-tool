/**
 * ocr.js - Tesseract.js OCR 识别模块
 * 自动识别微信聊天截图中"店长：XXX"的名字
 */

const OCR = (() => {
  let worker = null;
  let isReady = false;

  /**
   * 初始化 Tesseract Worker
   */
  async function init(onProgress) {
    if (isReady) return worker;

    onProgress && onProgress({ status: 'loading', progress: 0, message: '正在加载 OCR 引擎...' });

    // 使用 Tesseract.js v5 的 createWorker API
    worker = await Tesseract.createWorker('chi_sim', 1, {
      logger: (m) => {
        if (m.status === 'recognizing text') {
          onProgress && onProgress({
            status: 'loading',
            progress: m.progress || 0,
            message: '正在加载中文识别数据...'
          });
        }
      }
    });

    // 设置页面分割模式为自动检测（不限制字符集，让 OCR 完整识别后由正则过滤）
    await worker.setParameters({
      tessedit_pageseg_mode: '3', // 全自动页面分割
    });

    isReady = true;
    onProgress && onProgress({ status: 'ready', progress: 1, message: 'OCR 引擎就绪' });
    return worker;
  }

  /**
   * 裁剪图片上方区域（加快识别速度，店长名字在顶部）
   * @param {HTMLImageElement|string} img - 图片元素或 Data URL
   * @param {number} topRatio - 保留上方比例，默认 0.3
   * @returns {Promise<string>} - 裁剪后的 Data URL
   */
  function cropTopRegion(imgSrc, topRatio = 0.3) {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const cropHeight = Math.floor(img.height * topRatio);
        canvas.width = img.width;
        canvas.height = cropHeight;

        const ctx = canvas.getContext('2d');
        // 使用白色背景
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, img.width, cropHeight, 0, 0, img.width, cropHeight);

        resolve(canvas.toDataURL('image/png'));
      };
      img.src = imgSrc;
    });
  }

  /**
   * 对单张图片进行 OCR 识别
   * @param {File|string} imageInput - 图片文件或 Data URL
   * @param {object} options - 选项 { cropTop: boolean }
   * @returns {Promise<string>} 识别出的文字
   */
  async function recognize(imageInput, options = {}) {
    const { cropTop = true } = options;

    if (!isReady) {
      throw new Error('OCR 引擎未初始化，请先调用 init()');
    }

    let imageSource;
    if (imageInput instanceof File) {
      imageSource = URL.createObjectURL(imageInput);
    } else {
      imageSource = imageInput;
    }

    try {
      // 裁剪上方区域
      let finalSource = imageSource;
      if (cropTop) {
        finalSource = await cropTopRegion(imageSource, 0.35);
      }

      // OCR 识别
      const { data } = await worker.recognize(finalSource);
      return data.text || '';
    } catch (err) {
      console.error('OCR 识别失败:', err);
      throw err;
    }
  }

  /**
   * 从 OCR 文本中提取店长名字
   * @param {string} text - OCR 识别的原始文本
   * @returns {object} { name: string|null, raw: string }
   */
  function extractManagerName(text) {
    const cleaned = text.replace(/\s+/g, '').trim();
    // 匹配模式: 店长：XXX 或 店长:XXX 或 店长 XXX
    const patterns = [
      /店长[：:]\s*([^\n\r：:，,\s]{1,6})/,
      /店长\s+([^\n\r：:，,\s]{1,6})/,
    ];

    for (const pattern of patterns) {
      const match = cleaned.match(pattern);
      if (match && match[1]) {
        // 过滤掉明显不是名字的内容
        const name = match[1].trim();
        if (name.length >= 1 && name.length <= 6 && !/^[0-9]+$/.test(name)) {
          return { name, raw: match[0], fullText: cleaned };
        }
      }
    }

    return { name: null, raw: '', fullText: cleaned };
  }

  /**
   * 批量 OCR 识别（串行，避免内存爆炸）
   * @param {File[]} files - 图片文件数组
   * @param {function} onProgress - 进度回调 (current, total, result)
   * @returns {Promise<Array>} 识别结果数组
   */
  async function recognizeBatch(files, onProgress) {
    const results = [];
    const total = files.length;

    for (let i = 0; i < total; i++) {
      const file = files[i];
      try {
        const text = await recognize(file, { cropTop: true });
        const extracted = extractManagerName(text);
        results.push({
          file,
          index: i,
          text,
          name: extracted.name,
          raw: extracted.raw,
          fullText: extracted.fullText,
          success: !!extracted.name,
        });
      } catch (err) {
        results.push({
          file,
          index: i,
          text: '',
          name: null,
          raw: '',
          fullText: '',
          success: false,
          error: err.message,
        });
      }
      onProgress && onProgress(i + 1, total, results[i]);
    }

    return results;
  }

  /**
   * 销毁 worker
   */
  async function terminate() {
    if (worker) {
      await worker.terminate();
      worker = null;
      isReady = false;
    }
  }

  return {
    init,
    recognize,
    extractManagerName,
    recognizeBatch,
    terminate,
    get isReady() { return isReady; },
  };
})();

// 导出到全局
if (typeof window !== 'undefined') {
  window.OCR = OCR;
}
