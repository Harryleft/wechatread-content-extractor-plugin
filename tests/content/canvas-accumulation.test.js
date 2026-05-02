/**
 * Canvas 跨屏幕文本累积测试
 *
 * 模拟微信读书 Canvas 渲染行为，验证以下场景：
 * 1. 单屏文本提取（基准）
 * 2. 滚动后累积提取（核心修复）
 * 3. 多次滚动 + 多次提取
 * 4. 滚动重叠区域去重
 * 5. 章节切换时缓冲区重置
 */

/* eslint-disable no-undef */

// ── 模拟 canvas-hook.js 核心逻辑 ──

function createCanvasHook() {
  let captured = [];
  let captureBatch = 0;
  let currentFontSize = 0;
  let lastChapterUid = null;
  const seenLineTexts = new Set();

  function recordText(text, x, y) {
    if (typeof text !== 'string') return;
    if (!text.trim()) return;
    if (text.startsWith('abcdefghijklmn')) return;
    captured.push({
      t: text,
      x: parseFloat(x) || 0,
      y: parseFloat(y) || 0,
      s: currentFontSize,
      b: captureBatch
    });
  }

  function clearCanvas(width, height) {
    const isSubstantial = width >= 400 * 0.5 && height >= 800 * 0.5;
    if (isSubstantial) {
      captureBatch++;
    }
  }

  function changeChapter(uid) {
    captured = [];
    captureBatch = 0;
    seenLineTexts.clear();
    lastChapterUid = uid;
  }

  function setFontSize(size) {
    currentFontSize = size;
  }

  function buildCanvasText() {
    const snapshot = captured.slice();
    const sorted = snapshot.sort(function (a, b) {
      return a.b - b.b || a.y - b.y || a.x - b.x;
    });

    const lines = [];
    let currentLine = null;
    let lastBatch = -1;

    for (let i = 0; i < sorted.length; i += 1) {
      const item = sorted[i];
      const batchChanged = item.b !== lastBatch;

      if (!currentLine || batchChanged || Math.abs(item.y - currentLine.y) > 3) {
        if (currentLine) lines.push(Object.assign({}, currentLine, { batch: lastBatch }));
        currentLine = {
          y: item.y,
          parts: [{ x: item.x, t: item.t }],
          fontSize: item.s
        };
        lastBatch = item.b;
      } else {
        currentLine.parts.push({ x: item.x, t: item.t });
      }
    }

    if (currentLine) lines.push(Object.assign({}, currentLine, { batch: lastBatch }));

    const result = [];
    const emitted = new Set();
    let previousBatch = -1;

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      var parts = dedupeLineParts(line.parts);
      parts.sort(function (a, b) {
        return a.x - b.x;
      });
      const text = parts.map(function (part) {
        return part.t;
      }).join('');

      if (emitted.has(text)) continue;
      emitted.add(text);

      if (previousBatch >= 0 && line.batch !== previousBatch) {
        result.push('');
      }

      if (line.fontSize >= 27) {
        result.push('## ' + text);
      } else if (line.fontSize >= 23) {
        result.push('### ' + text);
      } else {
        result.push(text);
      }

      previousBatch = line.batch;
    }

    return {
      raw: sorted,
      text: result.join('\n'),
      count: sorted.length
    };
  }

  function dedupeLineParts(parts) {
    var result = [];
    var seen = new Set();

    for (var i = 0; i < parts.length; i += 1) {
      var part = parts[i];
      var key = Math.round(part.x) + '|' + part.t;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(part);
    }

    return result;
  }

  return { recordText, clearCanvas, changeChapter, setFontSize, buildCanvasText, getCaptured: () => captured };
}

// ── 辅助函数 ──

function generateScreenLines(startIdx, count, fontSize) {
  const lines = [];
  for (let i = 0; i < count; i++) {
    lines.push({
      text: '这是第' + (startIdx + i) + '行的内容，包含一些中文文字用于测试文本提取功能。',
      y: 50 + i * 30,
      fontSize: fontSize || 16
    });
  }
  return lines;
}

function renderScreen(hook, lines) {
  lines.forEach(function (line) {
    hook.setFontSize(line.fontSize || 16);
    hook.recordText(line.text, 20, line.y);
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error('ASSERT FAILED: ' + message);
  }
}

// ── 测试用例 ──

function testSingleScreenExtraction() {
  var hook = createCanvasHook();
  var lines = generateScreenLines(1, 10, 16);
  renderScreen(hook, lines);

  var result = hook.buildCanvasText();
  var textLines = result.text.split('\n');

  assert(textLines.length === 10, '单屏应输出10行，实际: ' + textLines.length);
  assert(result.count === 10, 'count 应为 10');
  console.log('PASS: testSingleScreenExtraction (' + result.count + ' items, ' + textLines.length + ' lines)');
}

function testScrollAccumulation() {
  var hook = createCanvasHook();

  // 第一屏：20行
  var screen1 = generateScreenLines(1, 20, 16);
  renderScreen(hook, screen1);

  // 滚动：Canvas 清空
  hook.clearCanvas(400, 800);

  // 第二屏：20行（不同内容）
  var screen2 = generateScreenLines(21, 20, 16);
  renderScreen(hook, screen2);

  var result = hook.buildCanvasText();
  var textLines = result.text.split('\n');

  // 应有40行文本（20 + 20），加上1个批次分隔空行 = 41
  assert(textLines.length === 41, '跨屏应输出41行(40文本+1空行)，实际: ' + textLines.length);
  assert(result.count === 40, 'count 应为 40');

  // 验证内容顺序：第一屏在前，第二屏在后
  assert(textLines[0].includes('第1行'), '第一行应是第1行');
  assert(textLines[19].includes('第20行'), '第20行应来自第一屏');
  assert(textLines[20] === '', '批次间应有空行分隔');
  assert(textLines[21].includes('第21行'), '空行后应是第21行');
  assert(textLines[40].includes('第40行'), '最后一行应是第40行');

  console.log('PASS: testScrollAccumulation (' + result.count + ' items, ' + textLines.length + ' lines)');
}

function testScrollWithOverlap() {
  var hook = createCanvasHook();

  // 第一屏：第1-20行
  var screen1 = generateScreenLines(1, 20, 16);
  renderScreen(hook, screen1);

  // 滚动
  hook.clearCanvas(400, 800);

  // 第二屏：第15-35行（与第一屏有5行重叠：15,16,17,18,19,20）
  var screen2 = generateScreenLines(15, 21, 16);
  renderScreen(hook, screen2);

  var result = hook.buildCanvasText();
  var textLines = result.text.split('\n');

  // 去重后应有 35 行唯一文本（1-35行），去掉了6行重叠（15-20）
  var nonEmptyLines = textLines.filter(function (l) { return l !== ''; });
  assert(nonEmptyLines.length === 35, '去重后应有35行，实际: ' + nonEmptyLines.length);

  // 验证没有重复
  var seen = new Set();
  nonEmptyLines.forEach(function (line) {
    assert(!seen.has(line), '不应有重复行: ' + line);
    seen.add(line);
  });

  console.log('PASS: testScrollWithOverlap (' + nonEmptyLines.length + ' unique lines)');
}

function testMultipleScrolls() {
  var hook = createCanvasHook();

  // 模拟4次滚动，每次15行，共60行
  for (var batch = 0; batch < 4; batch++) {
    if (batch > 0) hook.clearCanvas(400, 800);
    var lines = generateScreenLines(batch * 15 + 1, 15, 16);
    renderScreen(hook, lines);
  }

  var result = hook.buildCanvasText();
  var nonEmptyLines = result.text.split('\n').filter(function (l) { return l !== ''; });

  assert(nonEmptyLines.length === 60, '4次滚动应累积60行，实际: ' + nonEmptyLines.length);
  assert(result.count === 60, 'count 应为 60');

  console.log('PASS: testMultipleScrolls (' + nonEmptyLines.length + ' lines across 4 batches)');
}

function testChapterChange() {
  var hook = createCanvasHook();

  // 章节1：渲染一些文本
  renderScreen(hook, generateScreenLines(1, 10, 16));
  assert(hook.getCaptured().length === 10, '章节1应有10条记录');

  // 切换章节
  hook.changeChapter('chapter-2');
  assert(hook.getCaptured().length === 0, '章节切换后应清空缓冲区');

  // 章节2：渲染新文本
  renderScreen(hook, generateScreenLines(1, 5, 16));
  var result = hook.buildCanvasText();
  var nonEmptyLines = result.text.split('\n').filter(function (l) { return l !== ''; });

  assert(nonEmptyLines.length === 5, '新章节应有5行，实际: ' + nonEmptyLines.length);
  assert(result.count === 5, 'count 应为 5');

  console.log('PASS: testChapterChange');
}

function testLargeChapterSimulation() {
  var hook = createCanvasHook();

  // 模拟一个长章节：10屏滚动，每屏30行，共300行
  // 这模拟了用户报告的"只能抓3700字符"的问题场景
  var totalLines = 300;
  var linesPerScreen = 30;
  var screens = Math.ceil(totalLines / linesPerScreen);

  for (var s = 0; s < screens; s++) {
    if (s > 0) hook.clearCanvas(400, 800);
    var startLine = s * linesPerScreen + 1;
    var count = Math.min(linesPerScreen, totalLines - s * linesPerScreen);
    renderScreen(hook, generateScreenLines(startLine, count, 16));
  }

  var result = hook.buildCanvasText();
  var nonEmptyLines = result.text.split('\n').filter(function (l) { return l !== ''; });

  assert(nonEmptyLines.length === totalLines,
    '长章节应累积' + totalLines + '行，实际: ' + nonEmptyLines.length);

  var totalChars = result.text.length;
  console.log('PASS: testLargeChapterSimulation (' + totalLines + ' lines, ' +
    totalChars + ' chars across ' + screens + ' screens)');

  // 验证之前的 bug：如果只取第一屏，约30行 ≈ 900字
  // 修复后应取全部 300 行
  assert(totalChars > 3000, '长章节总字符数应远超3700限制: ' + totalChars);
}

function testTitleFontSize() {
  var hook = createCanvasHook();

  // 第一屏含标题
  hook.setFontSize(28);
  hook.recordText('章节标题', 20, 50);
  hook.setFontSize(16);
  hook.recordText('正文内容第一行', 20, 100);
  hook.recordText('正文内容第二行', 20, 130);

  hook.clearCanvas(400, 800);

  // 第二屏
  hook.setFontSize(16);
  hook.recordText('正文内容第三行', 20, 50);
  hook.recordText('正文内容第四行', 20, 80);

  var result = hook.buildCanvasText();
  var textLines = result.text.split('\n');

  assert(textLines[0] === '## 章节标题', '标题应以 ## 开头');
  assert(textLines[1] === '正文内容第一行', '正文应正确输出');
  // 批次间有空行
  var emptyIdx = textLines.indexOf('');
  assert(emptyIdx > 0, '批次间应有空行');
  assert(textLines[emptyIdx + 1] === '正文内容第三行', '第二屏内容在空行之后');

  console.log('PASS: testTitleFontSize');
}

function testRepeatedExtraction() {
  var hook = createCanvasHook();

  // 渲染第一屏
  renderScreen(hook, generateScreenLines(1, 10, 16));
  var result1 = hook.buildCanvasText();
  var lines1 = result1.text.split('\n').filter(function (l) { return l !== ''; });
  assert(lines1.length === 10, '首次提取应有10行');

  // 再次提取，不清空，应得到相同结果
  var result2 = hook.buildCanvasText();
  var lines2 = result2.text.split('\n').filter(function (l) { return l !== ''; });
  assert(lines2.length === 10, '再次提取仍应有10行');

  // 滚动后渲染新内容
  hook.clearCanvas(400, 800);
  renderScreen(hook, generateScreenLines(11, 10, 16));

  var result3 = hook.buildCanvasText();
  var lines3 = result3.text.split('\n').filter(function (l) { return l !== ''; });
  assert(lines3.length === 20, '滚动后提取应有20行');

  console.log('PASS: testRepeatedExtraction');
}

function testDuplicateGlyphDrawsAreDeduped() {
  var hook = createCanvasHook();

  hook.setFontSize(16);
  hook.recordText('语', 20, 50);
  hook.recordText('语', 20, 50);
  hook.recordText('言', 40, 50);
  hook.recordText('言', 40, 50);

  var result = hook.buildCanvasText();
  var lines = result.text.split('\n').filter(function (l) { return l !== ''; });

  assert(lines.length === 1, '重复绘制应只输出一行');
  assert(lines[0] === '语言', '同坐标重复绘制不应输出为: ' + lines[0]);

  console.log('PASS: testDuplicateGlyphDrawsAreDeduped');
}

// ── 运行所有测试 ──

console.log('=== Canvas 跨屏幕文本累积测试 ===\n');

var tests = [
  testSingleScreenExtraction,
  testScrollAccumulation,
  testScrollWithOverlap,
  testMultipleScrolls,
  testChapterChange,
  testLargeChapterSimulation,
  testTitleFontSize,
  testRepeatedExtraction,
  testDuplicateGlyphDrawsAreDeduped
];

var passed = 0;
var failed = 0;

tests.forEach(function (test) {
  try {
    test();
    passed++;
  } catch (e) {
    failed++;
    console.error('FAIL: ' + test.name + ' - ' + e.message);
  }
});

console.log('\n=== 结果: ' + passed + ' passed, ' + failed + ' failed ===');
process.exit(failed > 0 ? 1 : 0);
