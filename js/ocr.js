/**
 * ocr.js - OCR 识别模块 (v4)
 *
 * 核心策略（多 pipeline 并行，任一命中即返回）：
 *   ★ 优先: 右侧区域裁剪（跳过左侧头像，聚焦文字区域）
 *     - 右侧裁顶15% + 反色（白字→黑字）
 *     - 右侧裁顶12% + 反色
 *     - 右侧裁顶 + 二值化(多阈值)
 *     - 右侧裁顶 + 蓝色通道增强
 *   ☆ 回退: 传统全宽裁剪策略
 *     - 原图 / 裁顶反色 / 蓝色增强 / 二值化 / 灰度拉伸
 *
 * 提取优化：
 *   - 增强「店长」模糊匹配（覆盖常見 OCR 误读变体）
 *   - 去空格后匹配
 *   - 兜底正则从全文中提取中文人名候选
 */

const OCR = (() => {
  let worker = null;
  let isReady = false;
  let initError = null;

  // ========================= 初始化 =========================

  async function init(onProgress) {
    if (isReady && worker) return worker;

    onProgress && onProgress({ status: 'loading', progress: 0, message: '正在下载 OCR 引擎...' });

    try {
      worker = await Tesseract.createWorker('chi_sim', 1, {
        langPath: 'https://registry.npmmirror.com/tesseract.js-core/5.1.0/files/tessdata/',
        corePath: 'https://registry.npmmirror.com/tesseract.js-core/5.1.0/files/',
        logger: (m) => {
          if (m.status === 'loading tesseract core' || m.status === 'loading language traineddata') {
            onProgress && onProgress({
              status: 'loading',
              progress: m.progress || 0,
              message: m.status,
            });
          }
        },
      });
      isReady = true;
      initError = null;
      onProgress && onProgress({ status: 'ready', progress: 1, message: 'OCR 引擎就绪' });
      return worker;
    } catch (err) {
      console.error('OCR 初始化失败(淘宝镜像):', err);
      initError = err.message;
      try {
        onProgress && onProgress({ status: 'loading', progress: 0, message: '备用 CDN 加载中...' });
        worker = await Tesseract.createWorker('chi_sim');
        isReady = true;
        initError = null;
        onProgress && onProgress({ status: 'ready', progress: 1, message: 'OCR 引擎就绪（备用CDN）' });
        return worker;
      } catch (err2) {
        isReady = false;
        worker = null;
        initError = err2.message;
        throw new Error('OCR 引擎加载失败: ' + err2.message);
      }
    }
  }

  // ========================= 图像工具 =========================

  function fileToImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('图片解码失败'));
        img.src = e.target.result;
      };
      reader.onerror = () => reject(new Error('文件读取失败'));
      reader.readAsDataURL(file);
    });
  }

  function imageToDataURL(img) {
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return canvas.toDataURL('image/png');
  }

  /** 从 canvas 获取带 crop 信息的 dataURL */
  function canvasToDataURL(canvas) {
    return canvas.toDataURL('image/png');
  }

  /**
   * 策略R：裁右侧区域（跳过左侧头像），放大，反色
   * 微信截图顶部名字栏：左侧是头像，名字文字在头像右侧
   * 跳过左侧头像区域可以减少噪声，聚焦文字区域
   */
  function preprocessRightCrop(img, topRatio, leftSkipRatio, scale, mode) {
    const cropH = Math.floor(img.height * topRatio);
    const startX = Math.floor(img.width * leftSkipRatio);
    const cropW = img.width - startX;

    const canvas = document.createElement('canvas');
    canvas.width = cropW * scale;
    canvas.height = cropH * scale;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, startX, 0, cropW, cropH, 0, 0, canvas.width, canvas.height);

    if (mode === 'original') return canvas;

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const pixels = imageData.data;

    for (let i = 0; i < pixels.length; i += 4) {
      if (mode === 'invert') {
        pixels[i] = 255 - pixels[i];
        pixels[i + 1] = 255 - pixels[i + 1];
        pixels[i + 2] = 255 - pixels[i + 2];
      } else if (mode === 'binary-200' || mode === 'binary-180' || mode === 'binary-220') {
        const threshold = mode === 'binary-200' ? 200 : mode === 'binary-180' ? 180 : 220;
        const gray = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
        const val = gray < threshold ? 0 : 255;
        pixels[i] = val;
        pixels[i + 1] = val;
        pixels[i + 2] = val;
      } else if (mode === 'blue-enhance') {
        const b = pixels[i + 2];
        const r = pixels[i];
        const g = pixels[i + 1];
        const blueProminence = b - Math.max(r, g);
        let val;
        if (blueProminence > 15) {
          val = 0;
        } else {
          val = Math.max(200, (r + g + b) / 3);
        }
        pixels[i] = val;
        pixels[i + 1] = val;
        pixels[i + 2] = val;
      } else if (mode === 'stretch') {
        // 边处理边计算 min/max 需要两趟，这里简化：将非纯白像素拉暗
        const gray = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
        // 强化对比：浅色文字(在红色背景上)反色后变深，在二值化前先增强
        const enhanced = gray < 180 ? gray * 0.5 : gray * 1.2;
        const val = Math.min(255, Math.max(0, Math.round(enhanced)));
        pixels[i] = val;
        pixels[i + 1] = val;
        pixels[i + 2] = val;
      }
    }
    ctx.putImageData(imageData, 0, 0);
    return canvas;
  }

  // ========================= 预处理策略 =========================

  /**
   * 策略1：裁顶部，放大，原始色彩（不做任何颜色处理）
   */
  function preprocessCropOnly(img, topRatio, scale) {
    const cropH = Math.floor(img.height * topRatio);
    const canvas = document.createElement('canvas');
    canvas.width = img.width * scale;
    canvas.height = cropH * scale;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, img.width, cropH, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  /**
   * 策略2：裁顶部 + 放大 + 反色（适合浅色文字）
   */
  function preprocessInvert(img, topRatio, scale) {
    const cropH = Math.floor(img.height * topRatio);
    const canvas = document.createElement('canvas');
    canvas.width = img.width * scale;
    canvas.height = cropH * scale;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, img.width, cropH, 0, 0, canvas.width, canvas.height);

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const pixels = imageData.data;
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i] = 255 - pixels[i];       // R 反色
      pixels[i + 1] = 255 - pixels[i + 1]; // G 反色
      pixels[i + 2] = 255 - pixels[i + 2]; // B 反色
    }
    ctx.putImageData(imageData, 0, 0);
    return canvas;
  }

  /**
   * 策略3：裁顶部 + 放大 + 蓝色通道增强
   * 微信名字栏有时用蓝色文字，提取蓝色通道并做对比度增强
   */
  function preprocessBlueChannel(img, topRatio, scale) {
    const cropH = Math.floor(img.height * topRatio);
    const canvas = document.createElement('canvas');
    canvas.width = img.width * scale;
    canvas.height = cropH * scale;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, img.width, cropH, 0, 0, canvas.width, canvas.height);

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const pixels = imageData.data;
    for (let i = 0; i < pixels.length; i += 4) {
      // 提取蓝色通道，放大差异性
      const b = pixels[i + 2];
      const r = pixels[i];
      const g = pixels[i + 1];
      // 蓝色突出的像素 → 加深（这些是文字）
      // 白色/灰色背景 → 变白
      const blueProminence = b - Math.max(r, g);
      let val;
      if (blueProminence > 15) {
        // 蓝色突出的区域（很可能是文字）→ 变成黑色
        val = 0;
      } else {
        // 背景 → 变成白色（或接近白色）
        val = Math.max(200, (r + g + b) / 3);
      }
      pixels[i] = val;
      pixels[i + 1] = val;
      pixels[i + 2] = val;
    }
    ctx.putImageData(imageData, 0, 0);
    return canvas;
  }

  /**
   * 策略4：裁顶部 + 放大 + 二值化（低阈值，捕获浅色文字）
   */
  function preprocessBinary(img, topRatio, scale, threshold) {
    const cropH = Math.floor(img.height * topRatio);
    const canvas = document.createElement('canvas');
    canvas.width = img.width * scale;
    canvas.height = cropH * scale;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, img.width, cropH, 0, 0, canvas.width, canvas.height);

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const pixels = imageData.data;
    for (let i = 0; i < pixels.length; i += 4) {
      const gray = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
      // 低于阈值 → 黑色（文字）；高于 → 白色（背景）
      const val = gray < threshold ? 0 : 255;
      pixels[i] = val;
      pixels[i + 1] = val;
      pixels[i + 2] = val;
    }
    ctx.putImageData(imageData, 0, 0);
    return canvas;
  }

  /**
   * 策略5：裁顶部 + 放大 + 灰度拉伸（把窄灰度范围拉伸到 0-255）
   */
  function preprocessStretch(img, topRatio, scale) {
    const cropH = Math.floor(img.height * topRatio);
    const canvas = document.createElement('canvas');
    canvas.width = img.width * scale;
    canvas.height = cropH * scale;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, img.width, cropH, 0, 0, canvas.width, canvas.height);

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const pixels = imageData.data;

    // 先找到最小和最大灰度值
    let minGray = 255, maxGray = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const gray = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
      if (gray < minGray) minGray = gray;
      if (gray > maxGray) maxGray = gray;
    }

    // 拉伸到 0-255
    const range = maxGray - minGray || 1;
    for (let i = 0; i < pixels.length; i += 4) {
      const gray = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
      const stretched = ((gray - minGray) / range) * 255;
      const val = Math.round(stretched);
      pixels[i] = val;
      pixels[i + 1] = val;
      pixels[i + 2] = val;
    }
    ctx.putImageData(imageData, 0, 0);
    return canvas;
  }

  // ========================= 文本提取 =========================

  /**
   * 增强版名字提取 — 模糊匹配「店长」变体
   *
   * 微信截图顶部通常有两种格式：
   *   「宋静霞 店长」— 名字在前
   *   「店长:宋静霞」— 名字在后
   *
   * OCR 可能把「店长」误读为:
   *   位上长、占长、电长、店张、店长 (正确)、佃长、占上长 等等
   */
  function extractManagerName(text) {
    // 去空格，保留原文本用于其他匹配
    const cleaned = text.replace(/\s+/g, '');
    const withSpaces = text;

    // ====== 第一步：「店长」模糊匹配 ======

    // 模式组A：名字在「店长」前面（如：宋静霞 店长）
    // 「店」的 OCR 变体：店、电、占、佃、沾、玷、点 、恬、惦、掂...
    // 「长」的 OCR 变体：长、張、张、上、K、k
    // 整体变体：位上长、店上长、占上长 等
    const dianPatterns = ['店', '电', '占', '佃', '位', '点', '玷', '惦'];
    const zhangPatterns = ['长', '長', '张', '張', '上', 'K', 'k'];

    // 生成所有「X长」组合正则
    for (const d of dianPatterns) {
      for (const z of zhangPatterns) {
        // 名字在前：1-6个字 + 店长
        const pattern = new RegExp('(.{1,6})' + d + z);
        const match = cleaned.match(pattern);
        if (match && match[1]) {
          const name = match[1].trim();
          if (isValidName(name)) {
            return { name, fullText: cleaned, method: '店长模糊匹配(名前)' };
          }
        }
      }
    }

    // 模式组B：名字在「店长」后面（如：店长:宋静霞）
    for (const d of dianPatterns) {
      for (const z of zhangPatterns) {
        const pattern = new RegExp(d + z + '[：:＝=]?(.{1,6})');
        const match = cleaned.match(pattern);
        if (match && match[1]) {
          const name = match[1].trim();
          if (isValidName(name)) {
            return { name, fullText: cleaned, method: '店长模糊匹配(名后)' };
          }
        }
      }
    }

    // 模式组C：名字和「店长」之间有空格（宋静霞 店 长）
    // 尝试从原始带空格文本中提取
    const spacedPattern = /(.{1,6})\s+[店电位占佃][\s]*[长長张Kk上]/;
    const spacedMatch = withSpaces.match(spacedPattern);
    if (spacedMatch && spacedMatch[1]) {
      const name = spacedMatch[1].trim();
      if (isValidName(name)) {
        return { name, fullText: cleaned, method: '店长空格匹配' };
      }
    }

    // ====== 第二步：兜底 — 提取全文中的中文名（2-4个字） ======
    // 从 cleaned 文本中找出连续的 2-4 个中文字符
    const allChineseNames = [];
    const chineseCharRegex = /[\u4e00-\u9fff]{2,4}/g;
    let m;
    while ((m = chineseCharRegex.exec(cleaned)) !== null) {
      const candidate = m[0];
      // 排除明显的非人名：数字、标点、常见非人名词汇
      if (isLikelyPersonName(candidate)) {
        allChineseNames.push(candidate);
      }
    }

    if (allChineseNames.length > 0) {
      // 优先返回第一个匹配（通常在 OCR 文本中靠前，对应图片顶部）
      return { name: allChineseNames[0], fullText: cleaned, method: '兜底中文名提取' };
    }

    return { name: null, fullText: cleaned, method: '未匹配' };
  }

  /** 校验是否为有效名字 */
  function isValidName(name) {
    if (!name || name.length < 1 || name.length > 8) return false;
    // 不能全是数字
    if (/^[0-9]+$/.test(name)) return false;
    // 不能全是店/长/电/占等误读字符
    if (/^[店电位占佃长張Kk上]+$/.test(name)) return false;
    // 至少包含一个中文字符
    if (!/[\u4e00-\u9fff]/.test(name)) return false;
    return true;
  }

  /** 判断候选文本是否可能是人名 */
  function isLikelyPersonName(text) {
    if (!text || text.length < 2 || text.length > 4) return false;
    // 必须全部是中文
    if (!/^[\u4e00-\u9fff]+$/.test(text)) return false;
    // 排除常见非人名词汇
    const nonNames = [
      '微信', '聊天', '图片', '群聊', '消息', '文件', '视频',
      '语音', '通话', '朋友圈', '联系人', '通讯录', '发现',
      '设置', '日期', '时间', '上午', '下午', '今天', '昨天',
      '明天', '分钟', '小时', '星期', '已经', '可以', '没有',
      '知道', '什么', '怎么', '这样', '那个', '这个', '还是',
      '因为', '所以', '但是', '如果', '虽然', '不过', '已经',
      '我们', '他们', '你们', '自己', '大家', '多少', '全部',
      '收到', '谢谢', '你好', '好的', '嗯嗯', '哈哈', '是的',
      '不是', '回复', '发送', '取消', '确定', '正在', '加载',
    ];
    return !nonNames.includes(text);
  }

  // ========================= 单次 OCR 识别 =========================

  async function tryRecognize(dataUrl) {
    const result = await worker.recognize(dataUrl);
    return (result && result.data && result.data.text) ? result.data.text : '';
  }

  // ========================= 多策略识别 =========================

  /**
   * 单图多策略识别
   * @returns {{ name, rawText, debug }}
   */
  async function recognizeWithDebug(file) {
    const debug = { attempts: [] };

    const img = await fileToImage(file);
    let bestResult = null;

    // 定义所有策略
    // 优先尝试「头像右侧裁剪」策略 — 微信截图名字栏文字在头像右侧
    // 随后回退到传统全宽裁剪策略
    const strategies = [
      // ====== 右侧裁剪策略（跳过左侧头像，聚焦文字区域）======
      {
        id: 'right-15pct-invert',
        label: '右侧裁顶15%反色',
        getDataUrl: () => canvasToDataURL(preprocessRightCrop(img, 0.15, 0.30, 2, 'invert')),
      },
      {
        id: 'right-12pct-invert',
        label: '右侧裁顶12%反色',
        getDataUrl: () => canvasToDataURL(preprocessRightCrop(img, 0.12, 0.30, 2, 'invert')),
      },
      {
        id: 'right-15pct-binary-200',
        label: '右侧裁顶15%二值化(阈200)',
        getDataUrl: () => canvasToDataURL(preprocessRightCrop(img, 0.15, 0.30, 2, 'binary-200')),
      },
      {
        id: 'right-15pct-binary-180',
        label: '右侧裁顶15%二值化(阈180)',
        getDataUrl: () => canvasToDataURL(preprocessRightCrop(img, 0.15, 0.30, 2, 'binary-180')),
      },
      {
        id: 'right-15pct-blue',
        label: '右侧裁顶15%蓝色增强',
        getDataUrl: () => canvasToDataURL(preprocessRightCrop(img, 0.15, 0.30, 2, 'blue-enhance')),
      },
      {
        id: 'right-12pct-binary-200',
        label: '右侧裁顶12%二值化(阈200)',
        getDataUrl: () => canvasToDataURL(preprocessRightCrop(img, 0.12, 0.30, 2, 'binary-200')),
      },
      {
        id: 'right-12pct-binary-180',
        label: '右侧裁顶12%二值化(阈180)',
        getDataUrl: () => canvasToDataURL(preprocessRightCrop(img, 0.12, 0.30, 2, 'binary-180')),
      },
      // 更激进的裁剪：跳过更多左侧区域
      {
        id: 'right-15pct-wide-invert',
        label: '右侧裁顶15%跳过40%反色',
        getDataUrl: () => canvasToDataURL(preprocessRightCrop(img, 0.15, 0.40, 2, 'invert')),
      },
      {
        id: 'right-15pct-wide-binary-180',
        label: '右侧裁顶15%跳过40%二值化',
        getDataUrl: () => canvasToDataURL(preprocessRightCrop(img, 0.15, 0.40, 2, 'binary-180')),
      },
      // ====== 传统全宽裁剪策略（回退） ======
      {
        id: 'full-original',
        label: '完整原图',
        getDataUrl: () => imageToDataURL(img),
      },
      {
        id: 'crop-12pct-invert',
        label: '裁顶12%反色',
        getDataUrl: () => canvasToDataURL(preprocessInvert(img, 0.12, 2)),
      },
      {
        id: 'crop-12pct-blue',
        label: '裁顶12%蓝色通道增强',
        getDataUrl: () => canvasToDataURL(preprocessBlueChannel(img, 0.12, 2)),
      },
      {
        id: 'crop-12pct-binary-200',
        label: '裁顶12%二值化(阈200)',
        getDataUrl: () => canvasToDataURL(preprocessBinary(img, 0.12, 2, 200)),
      },
      {
        id: 'crop-12pct-binary-180',
        label: '裁顶12%二值化(阈180)',
        getDataUrl: () => canvasToDataURL(preprocessBinary(img, 0.12, 2, 180)),
      },
      {
        id: 'crop-12pct-binary-220',
        label: '裁顶12%二值化(阈220)',
        getDataUrl: () => canvasToDataURL(preprocessBinary(img, 0.12, 2, 220)),
      },
      {
        id: 'crop-12pct-stretch',
        label: '裁顶12%灰度拉伸',
        getDataUrl: () => canvasToDataURL(preprocessStretch(img, 0.12, 2)),
      },
      {
        id: 'crop-8pct',
        label: '裁顶8%放大2x',
        getDataUrl: () => canvasToDataURL(preprocessCropOnly(img, 0.08, 2)),
      },
    ];

    // 依次尝试每种策略，命中即返回
    for (const strategy of strategies) {
      try {
        const dataUrl = strategy.getDataUrl();
        const text = await tryRecognize(dataUrl);
        const textPreview = text.length > 100 ? text.substring(0, 100) + '...' : text;

        const extractResult = extractManagerName(text);

        debug.attempts.push({
          strategy: strategy.id,
          label: strategy.label,
          text: textPreview,
          fullText: text,
          method: extractResult.method,
          name: extractResult.name || null,
        });

        if (extractResult.name) {
          // 找到了！记录并返回
          bestResult = {
            name: extractResult.name,
            rawText: text,
            method: extractResult.method,
            strategyId: strategy.id,
          };
          break;
        }
      } catch (e) {
        debug.attempts.push({
          strategy: strategy.id,
          label: strategy.label,
          error: e.message,
        });
      }
    }

    if (bestResult) {
      return { name: bestResult.name, rawText: bestResult.rawText, debug };
    }

    // 全部策略失败
    const lastText = debug.attempts
      .filter(a => a.fullText)
      .map(a => a.fullText)
      .pop() || '';
    return { name: null, rawText: lastText, debug };
  }

  // ========================= 批量识别 =========================

  async function recognizeBatch(files, onProgress) {
    if (!isReady || !worker) {
      throw new Error('OCR 引擎未初始化');
    }

    const results = [];
    const total = files.length;

    for (let i = 0; i < total; i++) {
      const file = files[i];
      try {
        const { name, rawText, debug } = await recognizeWithDebug(file);
        results.push({
          file, index: i,
          text: (rawText || '').substring(0, 200),
          name,
          fullText: rawText || '',
          success: !!name,
          debug,
        });
      } catch (err) {
        results.push({
          file, index: i,
          text: '', name: null, fullText: '',
          success: false, error: err.message,
          debug: { attempts: [{ error: err.message }] },
        });
      }
      onProgress && onProgress(i + 1, total, results[i]);
    }

    return results;
  }

  // ========================= 清理 =========================

  async function terminate() {
    if (worker) {
      try { await worker.terminate(); } catch (e) {}
      worker = null;
      isReady = false;
      initError = null;
    }
  }

  return {
    init, recognizeBatch, extractManagerName, terminate,
    get isReady() { return isReady; },
    get initError() { return initError; },
  };
})();

if (typeof window !== 'undefined') {
  window.OCR = OCR;
}
