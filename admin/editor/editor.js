/*
 * 블로그 에디터 (editor_original/js/editor.js의 수정본)
 *
 * 원본과 달라진 점 (SPEC.md 8장)
 * - 인라인 스타일을 쓰지 않는다. 서식은 의미 태그(strong, em, u, s, h2~h4, blockquote, ...)와
 *   미리 정한 클래스(.hl-*, .fs-*, .lh-2, .spoiler, .img-*)로만 나간다.
 * - 저장 직전 normalize(): DOMParser로 파싱 → style·허용 목록 밖의 태그·속성 제거 → 빈 태그 정리.
 * - 마크다운식 입력(**굵게**, # 제목, > 인용, ---, ``` 등)은 태그로 바꾼다. 대괄호 꾸밈 문법은 뺐다.
 * - 이미지는 업로드하지 않고 blob: 주소로 미리 보여 준다. 저장(커밋)은 /admin/editor/ 페이지가 맡는다.
 * - 글꼴·정렬·들여쓰기·루비·임베드·인용구/가로줄 스타일 선택은 뺐다.
 *
 * 사용: const ed = BlogEditor.create(rootElement, { maxImageBytes, onNotice })
 * rootElement 안에 [data-editor-toolbar], [data-editor-body] 등이 있어야 한다(/admin/editor/ 페이지 참고).
 */
(function () {
  'use strict';
  if (window.BlogEditor) return;

  // ======================
  // 허용 목록
  // ======================
  var BLOCKS = ['P', 'H2', 'H3', 'H4', 'UL', 'OL', 'BLOCKQUOTE', 'PRE', 'TABLE', 'HR', 'DETAILS'];
  var INLINES = ['STRONG', 'EM', 'U', 'S', 'A', 'CODE', 'SPAN', 'BR', 'IMG'];
  var STRUCTURE = ['LI', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'SUMMARY'];
  var ALLOWED = BLOCKS.concat(INLINES, STRUCTURE);
  var TEXT_BLOCKS = ['P', 'H2', 'H3', 'H4', 'SUMMARY', 'TH', 'TD'];
  var RENAME = { B: 'STRONG', I: 'EM', STRIKE: 'S', DEL: 'S', INS: 'U', H1: 'H2', H5: 'H4', H6: 'H4' };
  var DROP = [
    'SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE', 'NOSCRIPT', 'SVG', 'MATH', 'CANVAS', 'VIDEO',
    'AUDIO', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'FORM', 'LINK', 'META', 'TITLE', 'HEAD', 'CAPTION',
    'COLGROUP', 'COL',
  ];
  var DIV_LIKE = ['DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'ASIDE', 'NAV', 'FIGURE', 'CENTER', 'ADDRESS'];

  var CLASS_GROUPS = {
    color: ['hl-red', 'hl-blue', 'hl-green'],
    size: ['fs-small', 'fs-large', 'fs-xlarge'],
    spoiler: ['spoiler'],
  };
  var SPAN_CLASSES = CLASS_GROUPS.color.concat(CLASS_GROUPS.size, CLASS_GROUPS.spoiler);
  var LINE_CLASSES = ['lh-2'];
  var IMG_CLASSES = ['img-small', 'img-medium'];
  var CODE_LANGS = ['sql', 'python'];
  var IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

  var ZWSP = /[\u200B\uFEFF]/g;

  function isSafeHref(v) {
    return /^(https?:\/\/|mailto:|\/|#)/i.test(v);
  }

  function isSafeSrc(v) {
    return /^(blob:|https:\/\/|\/(?!\/))/i.test(v);
  }

  function keepClasses(el, allowed) {
    var list = (el.getAttribute('class') || '').split(/\s+/).filter(function (c) {
      return allowed.indexOf(c) !== -1;
    });
    // 같은 묶음(색·크기)에서는 하나만 남긴다.
    var seen = {};
    list = list.filter(function (c) {
      var g = groupOf(c) || c;
      if (seen[g]) return false;
      seen[g] = true;
      return true;
    });
    return list;
  }

  function groupOf(cls) {
    for (var g in CLASS_GROUPS) if (CLASS_GROUPS[g].indexOf(cls) !== -1) return g;
    return null;
  }

  function unwrap(el) {
    var parent = el.parentNode;
    if (!parent) return;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
  }

  function rename(el, tag) {
    var n = el.ownerDocument.createElement(tag);
    while (el.firstChild) n.appendChild(el.firstChild);
    for (var i = 0; i < el.attributes.length; i++) {
      var a = el.attributes[i];
      if (a.name === 'class' || a.name === 'href' || a.name === 'src' || a.name === 'alt') n.setAttribute(a.name, a.value);
    }
    el.parentNode.replaceChild(n, el);
    return n;
  }

  function isBlock(node) {
    return node.nodeType === 1 && (BLOCKS.indexOf(node.tagName) !== -1 || STRUCTURE.indexOf(node.tagName) !== -1);
  }

  function hasBlockChild(el) {
    for (var c = el.firstChild; c; c = c.nextSibling) {
      if (isBlock(c) || (c.nodeType === 1 && DIV_LIKE.indexOf(c.tagName) !== -1)) return true;
    }
    return false;
  }

  function isEmptyNode(el) {
    if (el.querySelector && el.querySelector('img,hr,table')) return false;
    return (el.textContent || '').replace(ZWSP, '').replace(/[\s\u00a0]/g, '') === '';
  }

  // --- 1단계: 태그·속성 정리 ---
  function sanitize(parent) {
    var children = Array.prototype.slice.call(parent.childNodes);
    children.forEach(function (node) {
      if (node.nodeType === 8) {
        parent.removeChild(node);
        return;
      }
      if (node.nodeType === 3) {
        var cleaned = node.data.replace(ZWSP, '');
        if (cleaned !== node.data) node.data = cleaned;
        return;
      }
      if (node.nodeType !== 1) {
        parent.removeChild(node);
        return;
      }
      var el = node;
      var tag = el.tagName.toUpperCase();
      if (DROP.indexOf(tag) !== -1) {
        parent.removeChild(el);
        return;
      }
      if (RENAME[tag]) {
        el = rename(el, RENAME[tag]);
        tag = el.tagName;
      }
      if (DIV_LIKE.indexOf(tag) !== -1) {
        // 블록을 품은 div는 풀고, 글자만 있는 div는 문단으로 본다.
        if (hasBlockChild(el)) {
          sanitize(el);
          unwrap(el);
          return;
        }
        el = rename(el, 'P');
        tag = 'P';
      }
      sanitize(el);
      if (ALLOWED.indexOf(tag) === -1) {
        unwrap(el);
        return;
      }
      cleanAttributes(el, tag);
    });
  }

  function cleanAttributes(el, tag) {
    var keep = {};
    if (tag === 'A') {
      var href = (el.getAttribute('href') || '').trim();
      if (!isSafeHref(href)) {
        unwrap(el);
        return;
      }
      keep.href = href;
    } else if (tag === 'IMG') {
      var src = (el.getAttribute('src') || '').trim();
      if (!isSafeSrc(src)) {
        el.parentNode.removeChild(el);
        return;
      }
      keep.src = src;
      keep.alt = el.getAttribute('alt') || '';
      var ic = keepClasses(el, IMG_CLASSES);
      if (ic.length) keep['class'] = ic[0];
    } else if (tag === 'SPAN') {
      var sc = keepClasses(el, SPAN_CLASSES);
      if (!sc.length) {
        unwrap(el);
        return;
      }
      keep['class'] = sc.join(' ');
    } else if (tag === 'CODE') {
      var m = /(?:^|\s)language-([\w-]+)/.exec(el.getAttribute('class') || '');
      if (m && CODE_LANGS.indexOf(m[1].toLowerCase()) !== -1) keep['class'] = 'language-' + m[1].toLowerCase();
    } else if (tag === 'P' || tag === 'LI') {
      var lc = keepClasses(el, LINE_CLASSES);
      if (lc.length) keep['class'] = lc[0];
    }
    var names = [];
    for (var i = 0; i < el.attributes.length; i++) names.push(el.attributes[i].name);
    names.forEach(function (n) {
      if (!Object.prototype.hasOwnProperty.call(keep, n)) el.removeAttribute(n);
    });
    // 순서를 일정하게: class를 앞에 둔다.
    Object.keys(keep).forEach(function (n) {
      if (el.getAttribute(n) !== keep[n]) el.setAttribute(n, keep[n]);
    });
  }

  // --- 2단계: 구조 정리 ---

  /** 블록 컨테이너(본문, 인용, 토글) 안의 낱글자·인라인을 문단으로 감싼다. */
  function wrapInlineRuns(container, doc) {
    // 엉뚱한 자리의 표·목록 조각(tr, td, li 등)은 먼저 풀어 글자만 남긴다.
    var stray;
    while (
      (stray = Array.prototype.filter.call(container.children, function (c) {
        return STRUCTURE.indexOf(c.tagName) !== -1 && c.tagName !== 'SUMMARY';
      })[0])
    ) {
      unwrapToInline(stray, doc);
    }
    var run = [];
    function flush(before) {
      if (!run.length) return;
      var onlySpace = run.every(function (n) {
        return n.nodeType === 3 && !n.data.replace(/[\s\u00a0]/g, '');
      });
      if (onlySpace) {
        run.forEach(function (n) {
          container.removeChild(n);
        });
      } else {
        var p = doc.createElement('p');
        container.insertBefore(p, before);
        run.forEach(function (n) {
          p.appendChild(n);
        });
      }
      run = [];
    }
    Array.prototype.slice.call(container.childNodes).forEach(function (n) {
      if (n.nodeType === 1 && BLOCKS.indexOf(n.tagName) !== -1) {
        flush(n);
      } else {
        run.push(n);
      }
    });
    flush(null);
  }

  /** 블록을 풀어 줄바꿈(<br>)으로 이어 붙인다. */
  function unwrapToInline(el, doc) {
    if (el.previousSibling && !(el.previousSibling.nodeType === 1 && el.previousSibling.tagName === 'BR')) {
      el.parentNode.insertBefore(doc.createElement('br'), el);
    }
    unwrap(el);
  }

  /** 글자만 담아야 하는 요소(문단, 제목, 칸 등) 안의 블록을 처리한다. */
  function fixTextBlock(el, doc) {
    Array.prototype.slice.call(el.childNodes).forEach(function (c) {
      if (isBlock(c)) {
        fixChildren(c, doc);
        if (c.tagName === 'HR' || c.tagName === 'TABLE' || c.tagName === 'DETAILS') {
          c.parentNode.removeChild(c);
        } else {
          Array.prototype.slice.call(c.querySelectorAll('*')).forEach(function (d) {
            if (isBlock(d)) unwrapToInline(d, doc);
          });
          unwrapToInline(c, doc);
        }
      } else if (c.nodeType === 1) {
        fixInline(c, doc);
      }
    });
  }

  /** 인라인 요소 안에 블록이 있으면 풀어 버린다. */
  function fixInline(el, doc) {
    Array.prototype.slice.call(el.querySelectorAll('*')).forEach(function (d) {
      if (isBlock(d)) unwrapToInline(d, doc);
    });
  }

  function fixPre(pre, doc) {
    var lang = '';
    var code = pre.querySelector('code[class]');
    if (code) lang = code.getAttribute('class');
    var text = '';
    (function walk(node) {
      for (var c = node.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) text += c.data;
        else if (c.nodeType === 1 && c.tagName === 'BR') text += '\n';
        else if (c.nodeType === 1) {
          var block = isBlock(c) && c.tagName !== 'CODE';
          if (block && text && !/\n$/.test(text)) text += '\n';
          walk(c);
          if (block && !/\n$/.test(text)) text += '\n';
        }
      }
    })(pre);
    text = text.replace(ZWSP, '').replace(/\u00a0/g, ' ').replace(/\n$/, '');
    while (pre.firstChild) pre.removeChild(pre.firstChild);
    var nc = doc.createElement('code');
    if (lang) nc.setAttribute('class', lang);
    nc.textContent = text;
    pre.appendChild(nc);
  }

  function fixList(list, doc) {
    Array.prototype.slice.call(list.childNodes).forEach(function (c) {
      if (c.nodeType === 1 && c.tagName === 'LI') return;
      if (c.nodeType === 1 && (c.tagName === 'UL' || c.tagName === 'OL')) {
        // 크롬이 들여쓰기로 만드는 <ul><li/><ul/></ul>을 <ul><li><ul/></li></ul>로 바꾼다.
        var prev = c.previousElementSibling;
        if (prev && prev.tagName === 'LI') {
          prev.appendChild(c);
          return;
        }
      }
      if (c.nodeType === 3 && !c.data.replace(/[\s\u00a0]/g, '')) {
        list.removeChild(c);
        return;
      }
      var li = doc.createElement('li');
      list.insertBefore(li, c);
      li.appendChild(c);
    });
  }

  function fixLi(li, doc) {
    Array.prototype.slice.call(li.childNodes).forEach(function (c) {
      if (c.nodeType !== 1) return;
      if (c.tagName === 'UL' || c.tagName === 'OL') return;
      if (isBlock(c)) {
        fixChildren(c, doc);
        if (c.tagName === 'HR' || c.tagName === 'TABLE' || c.tagName === 'DETAILS' || c.tagName === 'PRE') {
          // 목록 칸에는 글자와 하위 목록만 둔다.
          if (c.tagName === 'PRE') unwrapToInline(c, doc);
          else li.removeChild(c);
        } else {
          unwrapToInline(c, doc);
        }
      } else {
        fixInline(c, doc);
      }
    });
  }

  function fixTable(table, doc) {
    // tfoot·직접 tr 등은 tbody로 모은다.
    var thead = null;
    var tbody = null;
    var rows = [];
    Array.prototype.slice.call(table.querySelectorAll('tr')).forEach(function (tr) {
      if (tr.closest('table') !== table) return;
      var inHead = tr.parentNode.tagName === 'THEAD';
      rows.push({ tr: tr, head: inHead });
    });
    while (table.firstChild) table.removeChild(table.firstChild);
    rows.forEach(function (r) {
      var section;
      if (r.head) {
        if (!thead) thead = doc.createElement('thead');
        section = thead;
      } else {
        if (!tbody) tbody = doc.createElement('tbody');
        section = tbody;
      }
      Array.prototype.slice.call(r.tr.childNodes).forEach(function (c) {
        if (c.nodeType === 1 && (c.tagName === 'TD' || c.tagName === 'TH')) {
          fixTextBlock(c, doc);
          trimTrailingBr(c);
        } else {
          r.tr.removeChild(c);
        }
      });
      if (r.tr.childNodes.length) section.appendChild(r.tr);
    });
    if (thead) table.appendChild(thead);
    if (tbody) table.appendChild(tbody);
  }

  function fixDetails(details, doc) {
    details.removeAttribute('open');
    var summaries = Array.prototype.slice.call(details.childNodes).filter(function (c) {
      return c.nodeType === 1 && c.tagName === 'SUMMARY';
    });
    var summary = summaries.shift();
    summaries.forEach(function (s) {
      rename(s, 'P');
    });
    if (!summary) summary = doc.createElement('summary');
    details.insertBefore(summary, details.firstChild);
    fixTextBlock(summary, doc);
    trimTrailingBr(summary);
    var rest = doc.createElement('div');
    while (summary.nextSibling) rest.appendChild(summary.nextSibling);
    fixContainer(rest, doc);
    while (rest.firstChild) details.appendChild(rest.firstChild);
  }

  function trimTrailingBr(el) {
    var last = el.lastChild;
    while (last && ((last.nodeType === 1 && last.tagName === 'BR') || (last.nodeType === 3 && !last.data.replace(/[\s\u00a0]/g, '')))) {
      el.removeChild(last);
      last = el.lastChild;
    }
  }

  function fixChildren(el, doc) {
    var tag = el.tagName;
    if (tag === 'PRE') fixPre(el, doc);
    else if (tag === 'UL' || tag === 'OL') {
      fixList(el, doc);
      Array.prototype.slice.call(el.children).forEach(function (li) {
        fixLi(li, doc);
        trimTrailingBr(li);
        Array.prototype.slice.call(li.children).forEach(function (c) {
          if (c.tagName === 'UL' || c.tagName === 'OL') fixChildren(c, doc);
        });
      });
    } else if (tag === 'TABLE') fixTable(el, doc);
    else if (tag === 'DETAILS') fixDetails(el, doc);
    else if (tag === 'BLOCKQUOTE') fixContainer(el, doc);
    else if (TEXT_BLOCKS.indexOf(tag) !== -1) {
      fixTextBlock(el, doc);
      trimTrailingBr(el);
    }
  }

  function fixContainer(container, doc) {
    wrapInlineRuns(container, doc);
    Array.prototype.slice.call(container.children).forEach(function (c) {
      fixChildren(c, doc);
    });
  }

  // --- 3단계: 빈 태그 정리 ---
  function removeEmpty(container) {
    // 안쪽부터 지운다.
    var all = Array.prototype.slice.call(container.querySelectorAll('*')).reverse();
    all.forEach(function (el) {
      if (!el.parentNode) return;
      var tag = el.tagName;
      if (['STRONG', 'EM', 'U', 'S', 'A', 'CODE', 'SPAN'].indexOf(tag) !== -1) {
        if (el.parentNode.tagName === 'PRE') return;
        if (isEmptyNode(el) && !el.querySelector('br')) el.parentNode.removeChild(el);
        else if (isEmptyNode(el)) unwrap(el);
      } else if (['P', 'H2', 'H3', 'H4', 'BLOCKQUOTE', 'UL', 'OL'].indexOf(tag) !== -1) {
        if (isEmptyNode(el)) el.parentNode.removeChild(el);
      } else if (tag === 'LI') {
        if (isEmptyNode(el) && !el.querySelector('ul,ol')) el.parentNode.removeChild(el);
      } else if (tag === 'PRE') {
        if (!el.textContent.replace(/\s/g, '')) el.parentNode.removeChild(el);
      } else if (tag === 'TABLE') {
        if (!el.querySelector('td,th')) el.parentNode.removeChild(el);
      } else if (tag === 'DETAILS') {
        if (el.children.length <= 1 && isEmptyNode(el)) el.parentNode.removeChild(el);
      }
    });
  }

  /** 저장용 정규화. 결과는 블록마다 한 줄씩이다. */
  function normalize(html) {
    var doc = new DOMParser().parseFromString('<!doctype html><body>' + (html || '') + '</body>', 'text/html');
    var body = doc.body;
    sanitize(body);
    fixContainer(body, doc);
    removeEmpty(body);
    return Array.prototype.map
      .call(body.children, function (el) {
        return el.outerHTML;
      })
      .join('\n');
  }

  // ======================
  // 에디터
  // ======================
  function create(root, options) {
    options = options || {};
    var body = root.querySelector('[data-editor-body]');
    var toolbar = root.querySelector('[data-editor-toolbar]');
    var tableBar = root.querySelector('[data-editor-tablebar]');
    var imageBar = root.querySelector('[data-editor-imagebar]');
    var popover = root.querySelector('[data-editor-popover]');
    var fileInput = root.querySelector('[data-editor-file]');
    var images = new Map();
    var changeListeners = [];
    var savedRange = null;
    var selectedImg = null;
    var ac = new AbortController();
    var sig = { signal: ac.signal };

    body.contentEditable = 'true';
    body.spellcheck = true;

    function exec(cmd, value) {
      try {
        return document.execCommand(cmd, false, value);
      } catch (e) {
        return false;
      }
    }

    function prepareExec() {
      // 서식을 인라인 스타일이 아니라 태그로 넣고, Enter로 <p>를 만든다.
      exec('styleWithCSS', false);
      exec('defaultParagraphSeparator', 'p');
    }
    prepareExec();

    function notice(msg) {
      if (options.onNotice) options.onNotice(msg);
    }

    function changed() {
      changeListeners.forEach(function (cb) {
        cb();
      });
    }

    // ---------- 선택 영역 ----------
    function currentRange() {
      var sel = window.getSelection();
      if (sel && sel.rangeCount) {
        var r = sel.getRangeAt(0);
        if (body.contains(r.commonAncestorContainer)) return r;
      }
      return null;
    }

    function getRange() {
      return currentRange() || (savedRange && body.contains(savedRange.commonAncestorContainer) ? savedRange : null);
    }

    function restoreRange() {
      var r = getRange();
      body.focus({ preventScroll: true });
      if (r) setRange(r);
      return r;
    }

    function setRange(r) {
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      savedRange = r.cloneRange();
    }

    function caretAt(node, offset) {
      var r = document.createRange();
      r.setStart(node, offset);
      r.collapse(true);
      setRange(r);
    }

    function caretInto(el, atEnd) {
      var r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(!atEnd);
      body.focus({ preventScroll: true });
      setRange(r);
    }

    function closest(node, selector) {
      var el = node && (node.nodeType === 1 ? node : node.parentElement);
      el = el && el.closest(selector);
      return el && body.contains(el) && el !== body ? el : null;
    }

    /** 블록 컨테이너(본문, 인용, 토글)의 직계 자식 블록 */
    function isContainer(el) {
      return el === body || el.tagName === 'BLOCKQUOTE' || el.tagName === 'DETAILS';
    }

    function blockOf(node) {
      var n = node;
      while (n && n !== body) {
        if (n.parentNode && isContainer(n.parentNode) && !(n.nodeType === 1 && n.tagName === 'SUMMARY')) return n;
        n = n.parentNode;
      }
      return null;
    }

    /** 글자를 직접 담은 블록 (문단, 제목, 목록 칸, 표 칸, 토글 제목) */
    function textBlockOf(node) {
      return closest(node, 'p,h2,h3,h4,li,td,th,summary,pre');
    }

    /** 선택 범위에 걸친, 같은 컨테이너 안의 블록들 */
    function selectedBlocks(r) {
      var a = blockOf(r.startContainer);
      var b = blockOf(r.endContainer);
      if (!a) return [];
      if (!b || a.parentNode !== b.parentNode) return [a];
      var list = [];
      for (var n = a; n; n = n.nextSibling) {
        list.push(n);
        if (n === b) break;
      }
      return list;
    }

    // 선택 위치 표시(구조를 바꾸는 동안 선택을 잃지 않게)
    function markSelection(r) {
      var start = document.createElement('span');
      start.setAttribute('data-sel', 's');
      var end = document.createElement('span');
      end.setAttribute('data-sel', 'e');
      var rEnd = r.cloneRange();
      rEnd.collapse(false);
      rEnd.insertNode(end);
      var rStart = r.cloneRange();
      rStart.collapse(true);
      rStart.insertNode(start);
      return { start: start, end: end };
    }

    function restoreMarks(m) {
      if (!m.start.parentNode || !m.end.parentNode) {
        [m.start, m.end].forEach(function (x) {
          if (x.parentNode) x.parentNode.removeChild(x);
        });
        return;
      }
      var r = document.createRange();
      r.setStartAfter(m.start);
      r.setEndBefore(m.end);
      var sp = m.start.parentNode;
      var ep = m.end.parentNode;
      var so = Array.prototype.indexOf.call(sp.childNodes, m.start);
      sp.removeChild(m.start);
      var eo = Array.prototype.indexOf.call(ep.childNodes, m.end);
      ep.removeChild(m.end);
      try {
        r.setStart(sp, so);
        r.setEnd(ep, eo);
      } catch (e) {
        r.selectNodeContents(sp);
        r.collapse(true);
      }
      body.focus({ preventScroll: true });
      setRange(r);
    }

    function newParagraph() {
      var p = document.createElement('p');
      p.appendChild(document.createElement('br'));
      return p;
    }

    function ensureTrailingParagraph() {
      var last = body.lastElementChild;
      if (!last || last.tagName !== 'P') body.appendChild(newParagraph());
      body.querySelectorAll('details').forEach(function (d) {
        if (d.children.length < 2) d.appendChild(newParagraph());
      });
    }

    function isEmptyBlock(el) {
      return el && el.tagName === 'P' && isEmptyNode(el) && !el.querySelector('img');
    }

    // ---------- 인라인 클래스 (강조색, 글자 크기, 블러) ----------

    /** 범위에 걸린 글자 노드를 블록별로 나눈 범위 목록 */
    function segments(r) {
      var walker = document.createTreeWalker(r.commonAncestorContainer, NodeFilter.SHOW_TEXT, {
        acceptNode: function (n) {
          return r.intersectsNode(n) && !closest(n, 'pre') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        },
      });
      var groups = [];
      var n;
      if (r.commonAncestorContainer.nodeType === 3) {
        if (!closest(r.commonAncestorContainer, 'pre')) groups.push({ block: textBlockOf(r.commonAncestorContainer), nodes: [r.commonAncestorContainer] });
      } else {
        while ((n = walker.nextNode())) {
          var blk = textBlockOf(n);
          var g = groups[groups.length - 1];
          if (g && g.block === blk) g.nodes.push(n);
          else groups.push({ block: blk, nodes: [n] });
        }
      }
      return groups
        .map(function (g) {
          var first = g.nodes[0];
          var last = g.nodes[g.nodes.length - 1];
          var s = document.createRange();
          s.setStart(first, first === r.startContainer ? r.startOffset : 0);
          s.setEnd(last, last === r.endContainer ? r.endOffset : last.data.length);
          return s;
        })
        .filter(function (s) {
          return !s.collapsed;
        });
    }

    function stripGroup(root, group) {
      var spans = root.querySelectorAll ? Array.prototype.slice.call(root.querySelectorAll('span')) : [];
      spans.forEach(function (s) {
        CLASS_GROUPS[group].forEach(function (c) {
          s.classList.remove(c);
        });
        if (!s.classList.length) unwrap(s);
      });
    }

    function groupAncestor(node, group) {
      var sel = CLASS_GROUPS[group]
        .map(function (c) {
          return 'span.' + c;
        })
        .join(',');
      return closest(node, sel);
    }

    /** anc를 잘라 inserted 부분만 anc 밖(같은 묶음 클래스 없음)으로 뺀다. */
    function splitOut(anc, first, last, group) {
      var before = document.createRange();
      before.setStart(anc, 0);
      before.setEndBefore(first);
      var after = document.createRange();
      after.setStartAfter(last);
      after.setEnd(anc, anc.childNodes.length);
      var fb = before.extractContents();
      var fa = after.extractContents();
      if (fb.textContent) {
        var b = anc.cloneNode(false);
        b.appendChild(fb);
        anc.parentNode.insertBefore(b, anc);
      }
      if (fa.textContent) {
        var a = anc.cloneNode(false);
        a.appendChild(fa);
        anc.parentNode.insertBefore(a, anc.nextSibling);
      }
      CLASS_GROUPS[group].forEach(function (c) {
        anc.classList.remove(c);
      });
      if (!anc.classList.length) unwrap(anc);
    }

    function applyClass(group, cls) {
      var r = restoreRange();
      if (!r || r.collapsed) {
        notice('먼저 글자를 선택하세요.');
        return;
      }
      var segs = segments(r);
      if (!segs.length) return;
      var firstNode = null;
      var lastNode = null;
      segs.forEach(function (s) {
        var anc = groupAncestor(s.commonAncestorContainer, group);
        var frag = s.extractContents();
        stripGroup(frag, group);
        var nodes;
        if (cls) {
          var span = document.createElement('span');
          span.className = cls;
          span.appendChild(frag);
          nodes = [span];
        } else {
          nodes = Array.prototype.slice.call(frag.childNodes);
        }
        if (!nodes.length) return;
        var holder = document.createDocumentFragment();
        nodes.forEach(function (x) {
          holder.appendChild(x);
        });
        s.insertNode(holder);
        if (anc && anc.contains(nodes[0])) {
          // 같은 묶음 클래스 안에 있었다면 그 밖으로 꺼낸다.
          var top1 = nodes[0];
          while (top1.parentNode !== anc) top1 = top1.parentNode;
          var top2 = nodes[nodes.length - 1];
          while (top2.parentNode !== anc) top2 = top2.parentNode;
          splitOut(anc, top1, top2, group);
        }
        if (!firstNode) firstNode = nodes[0];
        lastNode = nodes[nodes.length - 1];
      });
      if (firstNode && lastNode && firstNode.parentNode && lastNode.parentNode) {
        var nr = document.createRange();
        nr.setStartBefore(firstNode);
        nr.setEndAfter(lastNode);
        setRange(nr);
      }
      changed();
      updateState();
    }

    function toggleInlineCode() {
      var r = restoreRange();
      if (!r) return;
      var code = closest(r.startContainer, 'code');
      if (code && !closest(code, 'pre')) {
        var m = markSelection(r);
        unwrap(code);
        restoreMarks(m);
        changed();
        return;
      }
      if (r.collapsed) {
        notice('먼저 글자를 선택하세요.');
        return;
      }
      var segs = segments(r);
      var last = null;
      segs.forEach(function (s) {
        var text = s.toString();
        s.deleteContents();
        var c = document.createElement('code');
        c.textContent = text;
        s.insertNode(c);
        last = c;
      });
      if (last) {
        var z = document.createTextNode('\u200B');
        last.parentNode.insertBefore(z, last.nextSibling);
        caretAt(z, 1);
      }
      changed();
    }

    // ---------- 인라인 style 정리 ----------
    // Chrome은 제목과 문단을 합치거나(Backspace·Delete) 문단 형식을 바꿀 때 원래 글꼴·크기를
    // <span style="font-family…; font-size…">로 붙인다. 저장할 때는 지워지지만 편집 중에는 제목 글꼴·크기가
    // 그대로 보이므로, 생기는 즉시 지워 편집 화면을 저장 결과와 같게 둔다. (이미지는 괘선 맞춤용 style이 있어 제외)
    function removeStyles(root) {
      var styled = Array.prototype.slice.call(root.querySelectorAll('[style]:not(img)'));
      styled.forEach(function (el) {
        el.removeAttribute('style');
        if (el.tagName === 'SPAN' && !el.attributes.length) unwrap(el);
      });
      return styled.length > 0;
    }

    function stripInlineStyles() {
      if (!body.querySelector('[style]:not(img)')) return;
      // 노드를 옮기면 선택 위치가 흐트러지므로, 글자 노드 기준 위치를 기억했다가 되돌린다.
      var sel = window.getSelection();
      var pos = sel && sel.rangeCount ? [sel.anchorNode, sel.anchorOffset, sel.focusNode, sel.focusOffset] : null;
      if (pos) {
        Array.prototype.slice.call(body.querySelectorAll('span[style]')).forEach(function (el) {
          if (el.attributes.length > 1) return;
          var parent = el.parentNode;
          var idx = Array.prototype.indexOf.call(parent.childNodes, el);
          for (var k = 0; k < 4; k += 2) {
            if (pos[k] === el) {
              pos[k] = parent;
              pos[k + 1] = idx + pos[k + 1];
            } else if (pos[k] === parent && pos[k + 1] > idx) {
              pos[k + 1] += el.childNodes.length - 1;
            }
          }
        });
      }
      removeStyles(body);
      if (pos && pos[0] && pos[2] && body.contains(pos[0]) && body.contains(pos[2])) {
        try {
          sel.setBaseAndExtent(pos[0], pos[1], pos[2], pos[3]);
        } catch (e) {
          // 위치가 맞지 않으면 브라우저가 정한 선택을 그대로 둔다.
        }
      }
    }

    // ---------- 블록 ----------
    var SIMPLE_BLOCK = /^(P|H2|H3|H4)$/;

    function isBlankLine(nodes) {
      return nodes.every(function (n) {
        if (n.nodeType === 3) return /^[\s\u200B\uFEFF]*$/.test(n.data);
        if (n.nodeType !== 1) return true;
        return n.tagName !== 'IMG' && !n.hasAttribute('data-sel') && !n.querySelector('img,br,[data-sel]') && isEmptyNode(n);
      });
    }

    /** 꾸밈 태그(strong, span 등) 안에 있는 <br>을 잘라 블록 바로 아래로 꺼낸다(줄 단위로 나누기 위해). */
    function liftBreaks(block) {
      Array.prototype.slice.call(block.querySelectorAll('br')).forEach(function (br) {
        if (br.parentNode === block || !block.contains(br)) return;
        var top = br;
        while (top.parentNode !== block) top = top.parentNode;
        var after = document.createRange();
        after.setStartAfter(br);
        after.setEndAfter(top);
        var rest = after.extractContents();
        br.parentNode.removeChild(br);
        block.insertBefore(br, top.nextSibling);
        if (rest.textContent || (rest.querySelector && rest.querySelector('img,br,[data-sel]'))) {
          block.insertBefore(rest, br.nextSibling);
        }
        if (isBlankLine([top])) block.removeChild(top);
      });
    }

    /**
     * 블록 b를 tag로 바꾼다. 블록 안이 <br>로 여러 줄이면 선택(sel)에 걸친 줄만 새 블록으로 떼어 바꾼다.
     * 형식이 바뀐 부분은 글자 크기 클래스와 style을 지워 새 형식의 기본 글꼴·크기로 돌아가게 한다.
     */
    function convertBlock(b, tag, marks) {
      if (b.tagName === tag) return;
      liftBreaks(b);
      var sel = document.createRange();
      sel.setStartBefore(marks.start);
      sel.setEndAfter(marks.end);
      var lines = [{ nodes: [], br: null }];
      Array.prototype.slice.call(b.childNodes).forEach(function (n) {
        if (n.nodeType === 1 && n.tagName === 'BR') lines.push({ nodes: [], br: n });
        else lines[lines.length - 1].nodes.push(n);
      });
      // 마지막 <br>은 빈 줄을 보이게 하려고 붙은 자리표시이므로 줄로 세지 않는다.
      if (lines.length > 1 && isBlankLine(lines[lines.length - 1].nodes)) lines.pop();
      var groups = [];
      lines.forEach(function (ln) {
        var on = ln.nodes.some(function (n) {
          return sel.intersectsNode(n);
        });
        if (!on && !ln.nodes.length && ln.br) on = sel.intersectsNode(ln.br);
        if (lines.length === 1) on = true;
        var g = groups[groups.length - 1];
        if (g && g.on === on) g.lines.push(ln);
        else groups.push({ on: on, lines: [ln] });
      });
      var parent = b.parentNode;
      groups.forEach(function (g) {
        var el = g.on ? document.createElement(tag) : b.cloneNode(false);
        g.lines.forEach(function (ln, i) {
          if (i > 0) el.appendChild(document.createElement('br'));
          ln.nodes.forEach(function (n) {
            el.appendChild(n);
          });
        });
        if (isBlankLine(g.lines[g.lines.length - 1].nodes)) el.appendChild(document.createElement('br'));
        parent.insertBefore(el, b);
        if (g.on) {
          removeStyles(el);
          Array.prototype.slice.call(el.querySelectorAll('span')).forEach(function (s) {
            CLASS_GROUPS.size.forEach(function (c) {
              s.classList.remove(c);
            });
            if (!s.hasAttribute('data-sel') && !s.classList.length) unwrap(s);
          });
        }
      });
      parent.removeChild(b);
    }

    function setBlock(tag) {
      var r = restoreRange();
      if (!r) return;
      if (closest(r.startContainer, 'pre,summary,td,th') || closest(r.endContainer, 'pre,summary,td,th')) {
        notice('이 위치에서는 문단 형식을 바꿀 수 없습니다.');
        updateState();
        return;
      }
      var blocks = selectedBlocks(r);
      // 드래그·세 번 누르기로 다음 블록 맨 앞까지 잡힌 경우 그 블록은 빼고 바꾼다.
      if (blocks.length > 1) {
        var lastBlock = blocks[blocks.length - 1];
        var head = document.createRange();
        head.setStart(lastBlock, 0);
        head.setEnd(r.endContainer, r.endOffset);
        if (head.toString().replace(ZWSP, '') === '' && !head.cloneContents().querySelector('img')) {
          blocks.pop();
          r = r.cloneRange();
          r.setEnd(blocks[blocks.length - 1], blocks[blocks.length - 1].childNodes.length);
        }
      }
      var endBlock = blockOf(r.endContainer);
      var simple =
        blocks.length > 0 &&
        blocks[blocks.length - 1] === endBlock &&
        blocks.every(function (b) {
          return b.nodeType === 1 && SIMPLE_BLOCK.test(b.tagName);
        });
      if (!simple) {
        // 목록 칸 등은 브라우저 기능으로 바꾼다.
        exec('formatBlock', '<' + tag + '>');
        stripInlineStyles();
      } else {
        var m = markSelection(r);
        var TAG = tag.toUpperCase();
        blocks.forEach(function (b) {
          convertBlock(b, TAG, m);
        });
        restoreMarks(m);
      }
      changed();
      updateState();
    }

    function setLineHeight(cls) {
      var r = restoreRange();
      if (!r) return;
      var blocks = [];
      var start = closest(r.startContainer, 'p,li');
      var end = closest(r.endContainer, 'p,li');
      if (start) blocks.push(start);
      if (start && end && start !== end) {
        var all = Array.prototype.slice.call(body.querySelectorAll('p,li'));
        var i = all.indexOf(start);
        var j = all.indexOf(end);
        blocks = all.slice(i, j + 1);
      }
      if (!blocks.length) {
        notice('문단이나 목록에서만 행간을 바꿀 수 있습니다.');
        return;
      }
      blocks.forEach(function (b) {
        LINE_CLASSES.forEach(function (c) {
          b.classList.remove(c);
        });
        if (cls) b.classList.add(cls);
        if (!b.classList.length) b.removeAttribute('class');
      });
      changed();
    }

    function liftChildren(el) {
      // 인용·토글을 풀 때 안의 블록을 밖으로 꺼낸다.
      var parent = el.parentNode;
      var first = null;
      Array.prototype.slice.call(el.childNodes).forEach(function (c) {
        var node = c;
        if (c.nodeType === 1 && c.tagName === 'SUMMARY') {
          node = rename(c, 'P');
        } else if (c.nodeType === 3 || (c.nodeType === 1 && !isBlock(c))) {
          if (c.nodeType === 3 && !c.data.trim()) {
            el.removeChild(c);
            return;
          }
          var p = document.createElement('p');
          el.insertBefore(p, c);
          p.appendChild(c);
          node = p;
        }
        parent.insertBefore(node, el);
        if (!first) first = node;
      });
      parent.removeChild(el);
      return first;
    }

    function wrapBlocks(tag, prepare) {
      var r = restoreRange();
      if (!r) return null;
      var blocks = selectedBlocks(r);
      if (!blocks.length) {
        body.appendChild(newParagraph());
        blocks = [body.lastElementChild];
        caretInto(blocks[0]);
        r = getRange();
      }
      var m = markSelection(r);
      var wrapper = document.createElement(tag);
      blocks[0].parentNode.insertBefore(wrapper, blocks[0]);
      if (prepare) prepare(wrapper);
      blocks.forEach(function (b) {
        if (b.nodeType === 1) wrapper.appendChild(b);
        else if (b.data.trim()) {
          var p = document.createElement('p');
          p.appendChild(b);
          wrapper.appendChild(p);
        } else b.parentNode && b.parentNode.removeChild(b);
      });
      restoreMarks(m);
      return wrapper;
    }

    function toggleQuote() {
      var r = restoreRange();
      if (!r) return;
      var bq = closest(r.startContainer, 'blockquote');
      if (bq) {
        var m = markSelection(r);
        liftChildren(bq);
        restoreMarks(m);
      } else {
        if (closest(r.startContainer, 'pre,td,th,summary')) return;
        wrapBlocks('blockquote');
      }
      ensureTrailingParagraph();
      changed();
      updateState();
    }

    function toggleDetails() {
      var r = restoreRange();
      if (!r) return;
      var summary = closest(r.startContainer, 'summary');
      var d = summary ? summary.parentNode : null;
      if (d) {
        var m = markSelection(r);
        liftChildren(d);
        restoreMarks(m);
        ensureTrailingParagraph();
        changed();
        updateState();
        return;
      }
      if (closest(r.startContainer, 'pre,td,th,li')) {
        notice('문단에서 토글을 넣을 수 있습니다.');
        return;
      }
      var blocks = selectedBlocks(r);
      var details = document.createElement('details');
      details.open = true;
      var s = document.createElement('summary');
      if (blocks.length === 1 && isEmptyBlock(blocks[0])) {
        s.textContent = '토글 제목';
        blocks[0].parentNode.replaceChild(details, blocks[0]);
        details.appendChild(s);
        details.appendChild(newParagraph());
      } else if (blocks.length) {
        // 첫 블록 글자를 제목으로, 나머지를 내용으로 쓴다.
        var first = blocks[0];
        first.parentNode.insertBefore(details, first);
        if (first.tagName === 'P' || /^H[2-4]$/.test(first.tagName)) {
          while (first.firstChild) s.appendChild(first.firstChild);
          first.parentNode.removeChild(first);
          blocks = blocks.slice(1);
        } else {
          s.textContent = '토글 제목';
        }
        details.appendChild(s);
        blocks.forEach(function (b) {
          details.appendChild(b);
        });
        if (details.children.length < 2) details.appendChild(newParagraph());
      } else {
        s.textContent = '토글 제목';
        details.appendChild(s);
        details.appendChild(newParagraph());
        body.appendChild(details);
      }
      var sr = document.createRange();
      sr.selectNodeContents(s);
      body.focus({ preventScroll: true });
      setRange(sr);
      ensureTrailingParagraph();
      changed();
      updateState();
    }

    function insertBlockAfterCurrent(el, replaceEmpty) {
      var r = restoreRange();
      var cur = r ? blockOf(r.startContainer) : null;
      if (cur && replaceEmpty && isEmptyBlock(cur)) cur.parentNode.replaceChild(el, cur);
      else if (cur) cur.parentNode.insertBefore(el, cur.nextSibling);
      else body.appendChild(el);
      return el;
    }

    function paragraphAfter(el) {
      var next = el.nextElementSibling;
      if (!next || next.tagName !== 'P') {
        next = newParagraph();
        el.parentNode.insertBefore(next, el.nextSibling);
      }
      return next;
    }

    function insertHr() {
      var r = restoreRange();
      if (r && closest(r.startContainer, 'pre,td,th,li,summary')) return;
      var hr = insertBlockAfterCurrent(document.createElement('hr'), true);
      caretInto(paragraphAfter(hr));
      ensureTrailingParagraph();
      changed();
    }

    function makeCodeBlock(lang, text) {
      var pre = document.createElement('pre');
      var code = document.createElement('code');
      if (lang) code.className = 'language-' + lang;
      code.textContent = (text || '') + '\n';
      pre.appendChild(code);
      return pre;
    }

    function codeCaretEnd(pre) {
      var code = pre.querySelector('code') || pre;
      var t = code.lastChild;
      if (!t || t.nodeType !== 3) {
        t = document.createTextNode('\n');
        code.appendChild(t);
      }
      // 맨 끝의 줄바꿈(빈 줄 표시용) 앞에 커서를 둔다.
      var off = /\n$/.test(t.data) ? t.data.length - 1 : t.data.length;
      body.focus({ preventScroll: true });
      caretAt(t, off);
    }

    function setCodeBlock(lang) {
      var r = restoreRange();
      if (!r) return;
      var pre = closest(r.startContainer, 'pre');
      if (pre) {
        var code = pre.querySelector('code');
        if (!code) {
          code = document.createElement('code');
          while (pre.firstChild) code.appendChild(pre.firstChild);
          pre.appendChild(code);
        }
        code.className = lang ? 'language-' + lang : '';
        if (!code.className) code.removeAttribute('class');
        changed();
        updateState();
        return;
      }
      if (closest(r.startContainer, 'td,th,li,summary')) {
        notice('문단에서 코드 블록을 넣을 수 있습니다.');
        return;
      }
      var blocks = selectedBlocks(r).filter(function (b) {
        return b.nodeType === 1;
      });
      var text = blocks
        .map(function (b) {
          return b.innerText !== undefined ? b.innerText.replace(/\n$/, '') : b.textContent;
        })
        .join('\n')
        .replace(ZWSP, '');
      var newPre = makeCodeBlock(lang, text.trim() ? text : '');
      if (blocks.length) {
        blocks[0].parentNode.insertBefore(newPre, blocks[0]);
        blocks.forEach(function (b) {
          b.parentNode.removeChild(b);
        });
      } else {
        body.appendChild(newPre);
      }
      paragraphAfter(newPre);
      ensureTrailingParagraph();
      codeCaretEnd(newPre);
      changed();
      updateState();
    }

    function exitCodeBlock(pre) {
      var p = paragraphAfter(pre);
      caretInto(p);
    }

    function insertTable(rows, cols) {
      var r = restoreRange();
      if (r && closest(r.startContainer, 'pre,td,th,li,summary')) return;
      var table = document.createElement('table');
      var thead = document.createElement('thead');
      var tbody = document.createElement('tbody');
      for (var i = 0; i < rows; i++) {
        var tr = document.createElement('tr');
        for (var j = 0; j < cols; j++) {
          var cell = document.createElement(i === 0 ? 'th' : 'td');
          cell.appendChild(document.createElement('br'));
          tr.appendChild(cell);
        }
        (i === 0 ? thead : tbody).appendChild(tr);
      }
      table.appendChild(thead);
      if (rows > 1) table.appendChild(tbody);
      insertBlockAfterCurrent(table, true);
      paragraphAfter(table);
      ensureTrailingParagraph();
      caretInto(table.querySelector('th,td'));
      changed();
      updateState();
    }

    function tableCommand(cmd) {
      var r = restoreRange();
      var cell = r && closest(r.startContainer, 'td,th');
      if (!cell) return;
      var table = cell.closest('table');
      var row = cell.parentNode;
      var col = Array.prototype.indexOf.call(row.children, cell);
      var rows = Array.prototype.slice.call(table.querySelectorAll('tr'));
      function emptyCell(tag) {
        var c = document.createElement(tag);
        c.appendChild(document.createElement('br'));
        return c;
      }
      if (cmd === 'addRow') {
        var tbody = table.querySelector('tbody');
        if (!tbody) {
          tbody = document.createElement('tbody');
          table.appendChild(tbody);
        }
        var nr = document.createElement('tr');
        for (var i = 0; i < row.children.length; i++) nr.appendChild(emptyCell('td'));
        if (row.parentNode.tagName === 'THEAD') tbody.insertBefore(nr, tbody.firstChild);
        else row.parentNode.insertBefore(nr, row.nextSibling);
        caretInto(nr.children[Math.min(col, nr.children.length - 1)]);
      } else if (cmd === 'addCol') {
        rows.forEach(function (tr) {
          var ref = tr.children[col];
          var c = emptyCell(tr.parentNode.tagName === 'THEAD' ? 'th' : 'td');
          tr.insertBefore(c, ref ? ref.nextSibling : null);
        });
        caretInto(row.children[col + 1]);
      } else if (cmd === 'delRow') {
        var next = row.nextElementSibling || row.previousElementSibling;
        row.parentNode.removeChild(row);
        if (!table.querySelector('tr')) return removeTable(table);
        Array.prototype.slice.call(table.querySelectorAll('thead,tbody')).forEach(function (s) {
          if (!s.children.length) s.parentNode.removeChild(s);
        });
        caretInto((next && next.isConnected ? next : table.querySelector('tr')).children[0]);
      } else if (cmd === 'delCol') {
        rows.forEach(function (tr) {
          if (tr.children[col]) tr.removeChild(tr.children[col]);
        });
        if (!table.querySelector('td,th')) return removeTable(table);
        caretInto(row.children[Math.max(0, col - 1)] || table.querySelector('td,th'));
      } else if (cmd === 'delTable') {
        return removeTable(table);
      }
      changed();
      updateState();
    }

    function removeTable(table) {
      var p = paragraphAfter(table);
      table.parentNode.removeChild(table);
      caretInto(p);
      ensureTrailingParagraph();
      changed();
      updateState();
    }

    // ---------- 링크 ----------
    function normalizeUrl(v) {
      v = (v || '').trim();
      if (!v) return '';
      if (!/^[a-z][a-z0-9+.-]*:/i.test(v) && !/^[/#]/.test(v)) v = 'https://' + v;
      return isSafeHref(v) ? v : '';
    }

    function applyLink(url) {
      var r = restoreRange();
      if (!r) return;
      var a = closest(r.startContainer, 'a');
      if (a) {
        if (url) a.setAttribute('href', url);
        else {
          var m = markSelection(r);
          unwrap(a);
          restoreMarks(m);
        }
        changed();
        return;
      }
      if (!url) return;
      if (r.collapsed) {
        var t = document.createTextNode(url);
        r.insertNode(t);
        var nr = document.createRange();
        nr.selectNodeContents(t);
        setRange(nr);
      }
      prepareExec();
      exec('createLink', url);
      changed();
    }

    // ---------- 이미지 ----------
    function addImage(blob, origin) {
      var url = URL.createObjectURL(blob);
      images.set(url, { blob: blob, origin: origin || null });
      return url;
    }

    function insertImageFiles(files, range) {
      var list = Array.prototype.slice.call(files || []);
      if (!list.length) return;
      if (range) setRange(range);
      var r = restoreRange();
      var cur = r ? blockOf(r.startContainer) : null;
      if (r && closest(r.startContainer, 'pre,td,th,li,summary')) cur = blockOf(r.startContainer);
      var after = cur;
      var lastP = null;
      list.forEach(function (file) {
        if (IMAGE_TYPES.indexOf(file.type) === -1) {
          notice('png, jpg, gif, webp 이미지만 넣을 수 있습니다: ' + file.name);
          return;
        }
        if (options.maxImageBytes && file.size > options.maxImageBytes) {
          notice('이미지가 너무 큽니다(최대 ' + Math.round(options.maxImageBytes / 1048576) + 'MB): ' + file.name);
          return;
        }
        var img = document.createElement('img');
        img.src = addImage(file, null);
        img.alt = '';
        var p = document.createElement('p');
        p.appendChild(img);
        if (after && isEmptyBlock(after)) {
          after.parentNode.replaceChild(p, after);
        } else if (after) {
          after.parentNode.insertBefore(p, after.nextSibling);
        } else {
          body.appendChild(p);
        }
        after = p;
        lastP = p;
      });
      if (lastP) {
        caretInto(paragraphAfter(lastP));
        ensureTrailingParagraph();
        changed();
      }
    }

    function selectImage(img) {
      if (selectedImg && selectedImg !== img) selectedImg.classList.remove('is-selected');
      selectedImg = img;
      if (!img) {
        imageBar.hidden = true;
        return;
      }
      img.classList.add('is-selected');
      imageBar.hidden = false;
      positionNear(imageBar, img);
      var size = img.classList.contains('img-small') ? 'small' : img.classList.contains('img-medium') ? 'medium' : 'large';
      imageBar.querySelectorAll('[data-image-cmd]').forEach(function (b) {
        if (['small', 'medium', 'large'].indexOf(b.getAttribute('data-image-cmd')) !== -1) {
          b.setAttribute('aria-pressed', String(b.getAttribute('data-image-cmd') === size));
        }
      });
    }

    function imageCommand(cmd) {
      var img = selectedImg;
      if (!img || !img.isConnected) return selectImage(null);
      if (cmd === 'small' || cmd === 'medium' || cmd === 'large') {
        IMG_CLASSES.forEach(function (c) {
          img.classList.remove(c);
        });
        if (cmd !== 'large') img.classList.add('img-' + cmd);
        selectImage(img);
      } else if (cmd === 'alt') {
        openPopover('alt', imageBar.querySelector('[data-image-cmd="alt"]'));
        return;
      } else if (cmd === 'remove') {
        var p = img.parentNode;
        img.parentNode.removeChild(img);
        selectImage(null);
        if (p && p !== body && p.tagName === 'P' && isEmptyNode(p) && !p.querySelector('img')) {
          var next = p.nextElementSibling || p.previousElementSibling;
          p.parentNode.removeChild(p);
          ensureTrailingParagraph();
          caretInto(next && next.isConnected ? next : body.lastElementChild);
        }
      }
      changed();
    }

    function positionNear(el, target) {
      var rb = root.getBoundingClientRect();
      var tb = target.getBoundingClientRect();
      el.style.left = Math.max(0, tb.left - rb.left) + 'px';
      el.style.top = tb.bottom - rb.top + 4 + 'px';
    }

    // ---------- 작은 창(링크, 표, 코드 언어, 대체 텍스트) ----------
    var popoverKind = null;

    function closePopover() {
      popover.hidden = true;
      popover.replaceChildren();
      popoverKind = null;
    }

    function button(label, onClick, attrs) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'be-text-btn';
      b.textContent = label;
      if (attrs) Object.keys(attrs).forEach(function (k) {
        b.setAttribute(k, attrs[k]);
      });
      b.addEventListener('mousedown', function (e) {
        e.preventDefault();
      });
      b.addEventListener('click', onClick);
      return b;
    }

    function openPopover(kind, anchor) {
      if (popoverKind === kind) return closePopover();
      closePopover();
      popoverKind = kind;
      var r = getRange();
      if (r) savedRange = r.cloneRange();
      if (kind === 'link') {
        var a = r && closest(r.startContainer, 'a');
        var input = document.createElement('input');
        input.type = 'text';
        input.placeholder = 'https://';
        input.value = a ? a.getAttribute('href') : '';
        input.setAttribute('aria-label', '링크 주소');
        var form = document.createElement('form');
        form.className = 'be-pop-row';
        form.appendChild(input);
        form.appendChild(button('적용', function () {
          form.requestSubmit();
        }));
        if (a) {
          form.appendChild(
            button('링크 해제', function () {
              closePopover();
              applyLink('');
            }),
          );
        }
        form.addEventListener('submit', function (e) {
          e.preventDefault();
          var url = normalizeUrl(input.value);
          if (input.value.trim() && !url) {
            notice('링크 주소는 http(s)://, mailto:, / 로 시작해야 합니다.');
            return;
          }
          closePopover();
          applyLink(url);
        });
        popover.appendChild(form);
        setTimeout(function () {
          input.focus();
        }, 0);
      } else if (kind === 'alt') {
        var img = selectedImg;
        if (!img) return closePopover();
        var altInput = document.createElement('input');
        altInput.type = 'text';
        altInput.value = img.getAttribute('alt') || '';
        altInput.placeholder = '이미지 설명 (보이지 않는 글자)';
        altInput.setAttribute('aria-label', '이미지 설명');
        var altForm = document.createElement('form');
        altForm.className = 'be-pop-row';
        altForm.appendChild(altInput);
        altForm.appendChild(button('적용', function () {
          altForm.requestSubmit();
        }));
        altForm.addEventListener('submit', function (e) {
          e.preventDefault();
          img.setAttribute('alt', altInput.value.trim());
          closePopover();
          changed();
        });
        popover.appendChild(altForm);
        setTimeout(function () {
          altInput.focus();
        }, 0);
      } else if (kind === 'table') {
        var MAX = 8;
        var label = document.createElement('p');
        label.className = 'be-pop-label';
        label.textContent = '표 크기를 고르세요';
        var grid = document.createElement('div');
        grid.className = 'be-table-grid';
        grid.style.setProperty('--cols', String(MAX));
        for (var i = 1; i <= MAX; i++) {
          for (var j = 1; j <= MAX; j++) {
            (function (row, col) {
              var c = document.createElement('button');
              c.type = 'button';
              c.setAttribute('aria-label', row + '행 ' + col + '열');
              c.addEventListener('mousedown', function (e) {
                e.preventDefault();
              });
              c.addEventListener('mouseenter', function () {
                label.textContent = row + '행 × ' + col + '열 (첫 행은 제목 행)';
                grid.querySelectorAll('button').forEach(function (b, k) {
                  var rr = Math.floor(k / MAX) + 1;
                  var cc = (k % MAX) + 1;
                  b.classList.toggle('is-on', rr <= row && cc <= col);
                });
              });
              c.addEventListener('click', function () {
                closePopover();
                insertTable(row, col);
              });
              grid.appendChild(c);
            })(i, j);
          }
        }
        popover.appendChild(label);
        popover.appendChild(grid);
      } else if (kind === 'code') {
        var row = document.createElement('div');
        row.className = 'be-pop-row';
        [
          ['sql', 'SQL'],
          ['python', 'Python'],
          ['', '기본 텍스트'],
        ].forEach(function (l) {
          row.appendChild(
            button(l[1], function () {
              closePopover();
              setCodeBlock(l[0]);
            }),
          );
        });
        popover.appendChild(row);
      }
      popover.hidden = false;
      positionNear(popover, anchor);
    }

    // ---------- 툴바 상태 ----------
    function updateState() {
      var r = currentRange();
      if (!r) return;
      savedRange = r.cloneRange();
      var node = r.startContainer;
      var inPre = !!closest(node, 'pre');
      toolbar.querySelectorAll('[data-cmd]').forEach(function (b) {
        var cmd = b.getAttribute('data-cmd');
        var on = false;
        if (cmd === 'bold' || cmd === 'italic' || cmd === 'underline' || cmd === 'strikeThrough') {
          try {
            on = !inPre && document.queryCommandState(cmd);
          } catch (e) {
            on = false;
          }
        } else if (cmd === 'inlineCode') on = !inPre && !!closest(node, 'code');
        else if (cmd === 'spoiler') on = !!closest(node, 'span.spoiler');
        else if (cmd === 'quote') on = !!closest(node, 'blockquote');
        else if (cmd === 'toggle') on = !!closest(node, 'summary');
        else if (cmd === 'codeBlock') on = inPre;
        else if (cmd === 'link') on = !!closest(node, 'a');
        else if (cmd === 'ul') on = !!closest(node, 'ul');
        else if (cmd === 'ol') on = !!closest(node, 'ol');
        if (b.hasAttribute('aria-pressed')) b.setAttribute('aria-pressed', String(on));
      });
      var blockSel = toolbar.querySelector('[data-select="block"]');
      if (blockSel) {
        var tb = closest(node, 'h2,h3,h4,p');
        blockSel.value = tb && /^H[2-4]$/.test(tb.tagName) ? tb.tagName.toLowerCase() : 'p';
      }
      var sizeSel = toolbar.querySelector('[data-select="size"]');
      if (sizeSel) {
        // 기본 글자 크기가 '작게'이므로 .fs-small(예전 글)도 '작게'(빈 값)로 보인다.
        var sz = groupAncestor(node, 'size');
        var szc = sz ? CLASS_GROUPS.size.filter(function (c) {
          return sz.classList.contains(c);
        })[0] : '';
        sizeSel.value = szc === 'fs-small' ? '' : szc;
      }
      var colorSel = toolbar.querySelector('[data-select="color"]');
      if (colorSel) {
        var cl = groupAncestor(node, 'color');
        colorSel.value = cl ? CLASS_GROUPS.color.filter(function (c) {
          return cl.classList.contains(c);
        })[0] : '';
      }
      var lhSel = toolbar.querySelector('[data-select="lineHeight"]');
      if (lhSel) {
        var lb = closest(node, 'p,li');
        lhSel.value = lb && lb.classList.contains('lh-2') ? 'lh-2' : '';
      }
      tableBar.hidden = !closest(node, 'td,th');
      if (!tableBar.hidden) positionNear(tableBar, closest(node, 'table'));
    }

    // ---------- 마크다운식 입력 ----------
    var INLINE_MD = [
      { re: /\*\*\*([^*\s][^*]*?)\*\*\*$/, tags: ['strong', 'em'] },
      { re: /\*\*([^*\s][^*]*?)\*\*$/, tags: ['strong'] },
      { re: /(^|[^*\w])\*([^*\s][^*]*?)\*$/, tags: ['em'], lead: true },
      { re: /(^|[^_\w])_([^_\s][^_]*?)_$/, tags: ['u'], lead: true },
      { re: /~~([^~\s][^~]*?)~~$/, tags: ['s'] },
      { re: /`([^`]+)`$/, tags: ['code'] },
    ];

    function inlineMarkdown() {
      var r = currentRange();
      if (!r || !r.collapsed) return;
      var tn = r.startContainer;
      if (tn.nodeType !== 3 || closest(tn, 'pre,code')) return;
      var before = tn.data.slice(0, r.startOffset);
      for (var i = 0; i < INLINE_MD.length; i++) {
        var md = INLINE_MD[i];
        var m = md.re.exec(before);
        if (!m) continue;
        var start = m.index + (md.lead ? m[1].length : 0);
        var inner = md.lead ? m[2] : m[1];
        var after = tn.data.slice(r.startOffset);
        var outer = document.createElement(md.tags[0]);
        var innermost = outer;
        for (var k = 1; k < md.tags.length; k++) {
          var child = document.createElement(md.tags[k]);
          innermost.appendChild(child);
          innermost = child;
        }
        innermost.textContent = inner;
        tn.data = before.slice(0, start);
        var rest = document.createTextNode('\u200B' + after);
        tn.parentNode.insertBefore(rest, tn.nextSibling);
        tn.parentNode.insertBefore(outer, rest);
        caretAt(rest, 1);
        changed();
        return;
      }
    }

    /** 문단 처음에 # > - 1. 을 쓰고 스페이스를 누르면 블록으로 바꾼다. */
    function blockMarkdownOnSpace() {
      var r = currentRange();
      if (!r || !r.collapsed) return false;
      var p = closest(r.startContainer, 'p');
      if (!p || !isContainer(p.parentNode)) return false;
      var pre = document.createRange();
      pre.selectNodeContents(p);
      pre.setEnd(r.startContainer, r.startOffset);
      var marker = pre.toString().replace(ZWSP, '');
      var full = p.textContent.replace(ZWSP, '');
      if (marker !== full) return false;
      var map = { '#': 'h2', '##': 'h2', '###': 'h3', '####': 'h4', '>': 'blockquote', '-': 'ul', '*': 'ul', '1.': 'ol' };
      var kind = map[marker];
      if (!kind) return false;
      var el;
      if (kind === 'blockquote') {
        var np = newParagraph();
        el = document.createElement('blockquote');
        el.appendChild(np);
        p.parentNode.replaceChild(el, p);
        caretInto(np);
      } else if (kind === 'ul' || kind === 'ol') {
        el = document.createElement(kind);
        var li = document.createElement('li');
        li.appendChild(document.createElement('br'));
        el.appendChild(li);
        p.parentNode.replaceChild(el, p);
        caretInto(li);
      } else {
        el = document.createElement(kind);
        el.appendChild(document.createElement('br'));
        p.parentNode.replaceChild(el, p);
        caretInto(el);
      }
      ensureTrailingParagraph();
      changed();
      updateState();
      return true;
    }

    /** --- 또는 ```언어 문단에서 Enter를 누르면 가로줄·코드 블록으로 바꾼다. */
    // 인용구·토글의 마지막 빈 문단에서 Enter를 누르면 그 밖으로 나간다.
    function exitContainerOnEnter() {
      var r = currentRange();
      if (!r || !r.collapsed) return false;
      var p = closest(r.startContainer, 'p');
      if (!p || !isEmptyNode(p) || p.querySelector('img')) return false;
      var box = p.parentNode;
      if (box === body || !isContainer(box) || p.nextElementSibling) return false;
      var hasOther = Array.prototype.some.call(box.children, function (c) {
        return c !== p && c.tagName !== 'SUMMARY';
      });
      if (box.tagName === 'BLOCKQUOTE' && !hasOther) {
        box.parentNode.replaceChild(p, box);
      } else {
        box.parentNode.insertBefore(p, box.nextSibling);
      }
      caretInto(p);
      ensureTrailingParagraph();
      changed();
      updateState();
      return true;
    }

    function blockMarkdownOnEnter() {
      var r = currentRange();
      if (!r || !r.collapsed) return false;
      var p = closest(r.startContainer, 'p');
      if (!p || !isContainer(p.parentNode)) return false;
      var t = p.textContent.replace(ZWSP, '').trim();
      if (t === '---') {
        var hr = document.createElement('hr');
        p.parentNode.replaceChild(hr, p);
        caretInto(paragraphAfter(hr));
        ensureTrailingParagraph();
        changed();
        return true;
      }
      var m = /^```\s*(\w*)$/.exec(t);
      if (m) {
        var lang = m[1].toLowerCase();
        if (lang === 'py') lang = 'python';
        if (CODE_LANGS.indexOf(lang) === -1) lang = '';
        var preEl = makeCodeBlock(lang, '');
        p.parentNode.replaceChild(preEl, p);
        paragraphAfter(preEl);
        ensureTrailingParagraph();
        codeCaretEnd(preEl);
        changed();
        updateState();
        return true;
      }
      return false;
    }

    // ---------- 코드 블록 안의 키 ----------
    function insertPlainText(text) {
      var r = currentRange();
      if (!r) return;
      r.deleteContents();
      var tn = document.createTextNode(text);
      r.insertNode(tn);
      var pre = closest(tn, 'pre');
      if (pre) {
        // 마지막 줄이 보이도록 코드 끝에 줄바꿈 하나를 유지한다.
        // 커서 뒤에 아무것도 없으면 줄바꿈 하나를 더 두어야 새 줄이 보이고 커서가 그 줄로 간다.
        var code = pre.querySelector('code') || pre;
        var tail = document.createRange();
        tail.selectNodeContents(code);
        tail.setStartAfter(tn);
        if (!tail.toString()) code.appendChild(document.createTextNode('\n'));
      }
      caretAt(tn, tn.data.length);
      tn.parentNode.normalize();
      var r2 = currentRange();
      if (r2) savedRange = r2.cloneRange();
      changed();
    }

    function caretAtCodeEnd(pre) {
      var r = currentRange();
      if (!r || !r.collapsed) return false;
      var tail = document.createRange();
      tail.selectNodeContents(pre);
      tail.setStart(r.startContainer, r.startOffset);
      return !tail.toString().replace(/\n$/, '');
    }

    // ---------- 이벤트 ----------
    toolbar.addEventListener('mousedown', function (e) {
      if (e.target.closest('button')) e.preventDefault();
    });
    tableBar.addEventListener('mousedown', function (e) {
      e.preventDefault();
    });
    imageBar.addEventListener('mousedown', function (e) {
      e.preventDefault();
    });

    toolbar.addEventListener('click', function (e) {
      var b = e.target.closest('[data-cmd]');
      if (!b) return;
      var cmd = b.getAttribute('data-cmd');
      if (['link', 'table', 'codeBlock'].indexOf(cmd) === -1) closePopover();
      var r = getRange();
      var inPre = r && closest(r.startContainer, 'pre');
      switch (cmd) {
        case 'bold':
        case 'italic':
        case 'underline':
        case 'strikeThrough':
          if (inPre) return;
          restoreRange();
          prepareExec();
          exec(cmd);
          break;
        case 'inlineCode':
          if (!inPre) toggleInlineCode();
          break;
        case 'spoiler':
          if (inPre) return;
          var on = r && closest(r.startContainer, 'span.spoiler');
          applyClass('spoiler', on ? null : 'spoiler');
          break;
        case 'removeFormat':
          if (inPre) return;
          restoreRange();
          exec('removeFormat');
          break;
        case 'ul':
        case 'ol':
          if (inPre || (r && closest(r.startContainer, 'td,th,summary'))) return;
          restoreRange();
          prepareExec();
          exec(cmd === 'ul' ? 'insertUnorderedList' : 'insertOrderedList');
          break;
        case 'quote':
          toggleQuote();
          break;
        case 'toggle':
          toggleDetails();
          break;
        case 'link':
          if (!inPre) openPopover('link', b);
          break;
        case 'image':
          fileInput.click();
          break;
        case 'table':
          openPopover('table', b);
          break;
        case 'codeBlock':
          openPopover('code', b);
          break;
        case 'hr':
          insertHr();
          break;
        case 'undo':
        case 'redo':
          restoreRange();
          exec(cmd);
          break;
      }
      changed();
      updateState();
    });

    toolbar.addEventListener('change', function (e) {
      var s = e.target.closest('[data-select]');
      if (!s) return;
      var kind = s.getAttribute('data-select');
      if (kind === 'block') setBlock(s.value);
      else if (kind === 'size') applyClass('size', s.value || null);
      else if (kind === 'color') applyClass('color', s.value || null);
      else if (kind === 'lineHeight') setLineHeight(s.value || null);
    });

    tableBar.addEventListener('click', function (e) {
      var b = e.target.closest('[data-table-cmd]');
      if (b) tableCommand(b.getAttribute('data-table-cmd'));
    });

    imageBar.addEventListener('click', function (e) {
      var b = e.target.closest('[data-image-cmd]');
      if (b) imageCommand(b.getAttribute('data-image-cmd'));
    });

    fileInput.addEventListener('change', function () {
      insertImageFiles(fileInput.files);
      fileInput.value = '';
    });

    body.addEventListener('keydown', function (e) {
      // 한글 입력(조합) 중인 키는 건드리지 않는다.
      if (e.isComposing || e.keyCode === 229) return;
      var r = currentRange();
      if (!r) return;
      var node = r.startContainer;
      var mod = e.ctrlKey || e.metaKey;

      if (selectedImg && (e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault();
        imageCommand('remove');
        return;
      }
      if (selectedImg) selectImage(null);

      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        openPopover('link', toolbar.querySelector('[data-cmd="link"]'));
        return;
      }

      var pre = closest(node, 'pre');
      if (pre) {
        if (mod && (e.key === 'b' || e.key === 'i' || e.key === 'u')) {
          e.preventDefault();
          return;
        }
        if (e.key === 'Enter' && mod) {
          e.preventDefault();
          exitCodeBlock(pre);
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          insertPlainText('\n');
          return;
        }
        if (e.key === 'Tab' && !e.shiftKey) {
          e.preventDefault();
          insertPlainText('    ');
          return;
        }
        if (e.key === 'ArrowDown' && caretAtCodeEnd(pre)) {
          e.preventDefault();
          exitCodeBlock(pre);
          return;
        }
        if (e.key === 'Backspace' && !pre.textContent.replace(/\n/g, '')) {
          e.preventDefault();
          var np = newParagraph();
          pre.parentNode.replaceChild(np, pre);
          caretInto(np);
          changed();
          return;
        }
        return;
      }

      var summary = closest(node, 'summary');
      if (summary && e.key === 'Enter') {
        e.preventDefault();
        var details = summary.parentNode;
        details.open = true;
        var firstContent = summary.nextElementSibling;
        if (!firstContent) {
          firstContent = newParagraph();
          details.appendChild(firstContent);
        }
        caretInto(firstContent.tagName === 'P' ? firstContent : firstContent.querySelector('p,li,td') || firstContent);
        return;
      }

      var cell = closest(node, 'td,th');
      if (cell && e.key === 'Tab') {
        e.preventDefault();
        var cells = Array.prototype.slice.call(cell.closest('table').querySelectorAll('td,th'));
        var idx = cells.indexOf(cell) + (e.shiftKey ? -1 : 1);
        if (idx >= cells.length) {
          tableCommand('addRow');
          return;
        }
        if (idx >= 0) caretInto(cells[idx], true);
        return;
      }

      var li = closest(node, 'li');
      if (li && e.key === 'Tab') {
        e.preventDefault();
        prepareExec();
        exec(e.shiftKey ? 'outdent' : 'indent');
        changed();
        return;
      }

      if (e.key === ' ' && !mod && blockMarkdownOnSpace()) {
        e.preventDefault();
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey && !mod && exitContainerOnEnter()) {
        e.preventDefault();
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey && !mod && blockMarkdownOnEnter()) {
        e.preventDefault();
        return;
      }
    });

    body.addEventListener('input', function (e) {
      stripInlineStyles();
      if (e.inputType === 'insertText' && e.data && /[*_~`]/.test(e.data)) inlineMarkdown();
      changed();
    });

    body.addEventListener('paste', function (e) {
      var cd = e.clipboardData;
      if (!cd) return;
      e.preventDefault();
      var files = Array.prototype.filter.call(cd.files || [], function (f) {
        return f.type.indexOf('image/') === 0;
      });
      if (files.length) {
        insertImageFiles(files);
        return;
      }
      var text = (cd.getData('text/plain') || '').replace(/\r\n?/g, '\n');
      if (!text) return;
      var r = currentRange();
      if (r && closest(r.startContainer, 'pre')) {
        insertPlainText(text);
        return;
      }
      // 서식 없이 글자만 붙여넣는다. 줄바꿈은 문단으로 나눈다.
      prepareExec();
      text.split('\n').forEach(function (line, i) {
        if (i > 0) exec('insertParagraph');
        if (line) exec('insertText', line);
      });
      changed();
    });

    body.addEventListener('dragover', function (e) {
      if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') !== -1) e.preventDefault();
    });

    body.addEventListener('drop', function (e) {
      var files = e.dataTransfer && e.dataTransfer.files;
      if (!files || !files.length) return;
      e.preventDefault();
      var range = null;
      if (document.caretRangeFromPoint) range = document.caretRangeFromPoint(e.clientX, e.clientY);
      else if (document.caretPositionFromPoint) {
        var pos = document.caretPositionFromPoint(e.clientX, e.clientY);
        if (pos) {
          range = document.createRange();
          range.setStart(pos.offsetNode, pos.offset);
        }
      }
      if (range && !body.contains(range.startContainer)) range = null;
      insertImageFiles(files, range);
    });

    body.addEventListener('click', function (e) {
      var t = e.target;
      if (t.tagName === 'IMG') {
        selectImage(t);
        return;
      }
      selectImage(null);
      // 토글: 제목 글자를 누르면 편집, 왼쪽 삼각형 자리를 누르면 여닫기
      var summary = t.closest && t.closest('summary');
      if (summary && body.contains(summary)) {
        e.preventDefault();
        var rect = summary.getBoundingClientRect();
        if (e.clientX < rect.left) summary.parentNode.open = !summary.parentNode.open;
        return;
      }
      if (t.tagName === 'DETAILS' && body.contains(t)) {
        var s = t.querySelector(':scope > summary');
        if (s) {
          var sr = s.getBoundingClientRect();
          if (e.clientY >= sr.top && e.clientY <= sr.bottom && e.clientX < sr.left) {
            e.preventDefault();
            t.open = !t.open;
          }
        }
      }
    });

    document.addEventListener(
      'selectionchange',
      function () {
        if (!body.isConnected) return;
        if (currentRange()) updateState();
      },
      sig,
    );

    document.addEventListener(
      'mousedown',
      function (e) {
        if (!root.contains(e.target)) {
          closePopover();
          selectImage(null);
        } else if (popover.contains(e.target) === false && !e.target.closest('[data-cmd="link"],[data-cmd="table"],[data-cmd="codeBlock"],[data-image-cmd="alt"]')) {
          closePopover();
        }
      },
      sig,
    );

    document.addEventListener(
      'keydown',
      function (e) {
        if (e.key === 'Escape' && popoverKind) {
          closePopover();
          restoreRange();
        }
      },
      sig,
    );

    // ---------- 공개 API ----------
    function setHTML(html) {
      body.innerHTML = normalize(html);
      body.querySelectorAll('details').forEach(function (d) {
        d.open = true;
      });
      ensureTrailingParagraph();
      selectImage(null);
      closePopover();
    }

    return {
      getHTML: function () {
        return normalize(body.innerHTML);
      },
      setHTML: setHTML,
      addImage: addImage,
      images: images,
      onChange: function (cb) {
        changeListeners.push(cb);
      },
      focus: function () {
        body.focus();
      },
      destroy: function () {
        ac.abort();
        images.forEach(function (_, url) {
          URL.revokeObjectURL(url);
        });
        images.clear();
      },
    };
  }

  window.BlogEditor = { create: create, normalize: normalize };
})();
