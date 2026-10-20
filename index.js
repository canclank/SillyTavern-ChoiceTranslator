/**
 * 선택지 번역기 (SillyTavern 확장)
 * - 드래그한 텍스트 번역 → 팝업
 * - 메시지 원문에서 <choices> 같은 태그 내용만 꺼내 번역 → 팝업
 *   (메시지 화면은 건드리지 않으므로 다른 번역 확장과 함께 써도 충돌하지 않음)
 * - Connection Manager 프로필로 번역 모델 선택, 프롬프트 커스터마이즈
 */

const MODULE = 'sttr';
const LOG = '[선택지번역기]';

const DEFAULT_SYSTEM_PROMPT = `You are a professional translator for role-play and fiction.
Translate the user's text into {{language}}.
Output ONLY the translation. No explanations, notes, quotation marks, or preamble.
Preserve line breaks, numbering, bullet points and list structure exactly.
Keep character names and proper nouns consistent.`;

const DEFAULT_PROMPT = `Translate the following text into {{language}}:

{{text}}`;

const defaultSettings = Object.freeze({
    enabled: true,
    profileId: '',
    language: '한국어',
    maxTokens: 2000,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    prompt: DEFAULT_PROMPT,
    selectionEnabled: true,
    selectionOnlyInChat: true,
    tagTargets: 'choices',
    showMessageButton: true,
    autoMode: 'off', // off | prefetch | popup
    dockEnabled: true,
    dockTranslate: true,
    dockNav: true,
    dockPos: null, // { right, bottom } px
    saveTranslations: true, // 번역 결과 저장(캐시)
    showWandItem: true,     // 마법봉 메뉴에 "선택지 번역" 표시
});

const BUTTON_ICON = 'fa-list-check';

const EXT_FOLDER = (() => {
    try {
        const path = decodeURIComponent(new URL('.', import.meta.url).pathname);
        const m = path.match(/\/scripts\/extensions\/(.+?)\/?$/);
        if (m) return m[1];
    } catch { /* noop */ }
    return 'third-party/SillyTavern-ChoiceTranslator';
})();

const ctx = () => SillyTavern.getContext();

/* ------------------------------------------------------------------ */
/* 설정                                                                */
/* ------------------------------------------------------------------ */

function settings() {
    const { extensionSettings } = ctx();
    if (!extensionSettings[MODULE]) {
        extensionSettings[MODULE] = structuredClone(defaultSettings);
    }
    const s = extensionSettings[MODULE];

    // 1.0.0 설정 마이그레이션
    if (Object.hasOwn(s, 'autoTranslate')) {
        if (!Object.hasOwn(s, 'autoMode')) s.autoMode = s.autoTranslate ? 'popup' : 'off';
        delete s.autoTranslate;
    }
    delete s.tagDisplayMode;

    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(s, key)) s[key] = defaultSettings[key];
    }
    return s;
}

function saveSettings() {
    ctx().saveSettingsDebounced();
}

/* ------------------------------------------------------------------ */
/* 유틸                                                                */
/* ------------------------------------------------------------------ */

function hashStr(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
        h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36);
}

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function errMsg(err) {
    const parts = [];
    let cur = err;
    for (let depth = 0; cur && depth < 5; depth++) {
        const m = typeof cur === 'string' ? cur : cur.message;
        if (m && !parts.includes(m)) parts.push(m);
        cur = cur?.cause;
    }
    return parts.join(' → ') || '알 수 없는 오류';
}

/** 태그 안에 HTML이 섞여 있으면 줄바꿈을 살려 일반 텍스트로 변환 */
function htmlToText(str) {
    const src = String(str ?? '');
    if (!/<[a-z!/][^>]*>/i.test(src)) return src.trim();
    const withBreaks = src
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<li[^>]*>/gi, '• ')
        .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n');
    const doc = new DOMParser().parseFromString(withBreaks, 'text/html');
    return (doc.body.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
}

let saveChatTimer = null;
function saveChatSoon() {
    clearTimeout(saveChatTimer);
    saveChatTimer = setTimeout(() => {
        const c = ctx();
        try {
            (c.saveChatDebounced ?? c.saveChat)?.();
        } catch (e) {
            console.warn(LOG, '채팅 저장 실패', e);
        }
    }, 800);
}

async function copyToClipboard(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.append(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
    }
}

/* ------------------------------------------------------------------ */
/* 모델 호출                                                            */
/* ------------------------------------------------------------------ */

let connectionServicePromise = null;
async function getConnectionService() {
    const c = ctx();
    if (c.ConnectionManagerRequestService) return c.ConnectionManagerRequestService;
    connectionServicePromise ??= import('/scripts/extensions/shared.js')
        .then(m => m.ConnectionManagerRequestService ?? null)
        .catch(() => null);
    return connectionServicePromise;
}

function getProfiles() {
    return ctx().extensionSettings?.connectionManager?.profiles ?? [];
}

const TEXT_SENTINEL = '\u2063STTR_TEXT\u2063';

function fillTemplate(template, text, appendIfMissing) {
    const s = settings();
    let t = String(template ?? '').replaceAll('{{language}}', s.language || 'Korean');
    const hasText = t.includes('{{text}}');
    t = t.replaceAll('{{text}}', TEXT_SENTINEL);
    try {
        const { substituteParams } = ctx();
        if (typeof substituteParams === 'function') t = substituteParams(t);
    } catch { /* 매크로 치환 실패는 무시 */ }
    if (hasText) return t.replaceAll(TEXT_SENTINEL, text);
    if (!appendIfMissing) return t;
    return t.trim() ? `${t}\n\n${text}` : text;
}

function cleanOutput(out) {
    let t = String(out ?? '');
    t = t.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').trim();
    const fence = t.match(/^```[\w-]*\n([\s\S]*?)\n?```$/);
    if (fence) t = fence[1].trim();
    return t;
}

async function callModel(systemPrompt, userPrompt) {
    const s = settings();
    const maxTokens = Number(s.maxTokens) || 2000;

    if (s.profileId) {
        const service = await getConnectionService();
        if (!service) {
            throw new Error('Connection Manager를 불러올 수 없습니다. 실리태번을 업데이트하거나 Connection Manager 확장을 켜 주세요.');
        }
        if (!getProfiles().some(p => p.id === s.profileId)) {
            throw new Error('선택한 연결 프로필을 찾을 수 없습니다. 설정에서 다시 선택해 주세요.');
        }
        const messages = [];
        if (systemPrompt.trim()) messages.push({ role: 'system', content: systemPrompt });
        messages.push({ role: 'user', content: userPrompt });

        const result = await service.sendRequest(s.profileId, messages, maxTokens, {
            stream: false,
            extractData: true,
            includePreset: true,
            includeInstruct: true,
        });
        return typeof result === 'string' ? result : (result?.content ?? '');
    }

    const { generateRaw } = ctx();
    return await generateRaw({ systemPrompt, prompt: userPrompt, responseLength: maxTokens });
}

const memCache = new Map();

async function translateText(text, { useCache = true } = {}) {
    const source = String(text ?? '').trim();
    if (!source) throw new Error('번역할 텍스트가 비어 있습니다.');

    const s = settings();
    const systemPrompt = fillTemplate(s.systemPrompt, '', false);
    const userPrompt = fillTemplate(s.prompt, source, true);
    const key = hashStr([s.profileId, systemPrompt, userPrompt].join('\u0001'));

    const cacheOn = useCache && s.saveTranslations;
    if (cacheOn && memCache.has(key)) return memCache.get(key);

    const out = cleanOutput(await callModel(systemPrompt, userPrompt));
    if (!out) throw new Error('모델이 빈 응답을 반환했습니다.');

    if (s.saveTranslations) {
        memCache.set(key, out);
        if (memCache.size > 200) memCache.delete(memCache.keys().next().value);
    }
    return out;
}

/* ------------------------------------------------------------------ */
/* 태그 추출 & 번역 (메시지 DOM은 수정하지 않음)                          */
/* ------------------------------------------------------------------ */

const inflight = new Map(); // mesId → Promise

let parsedTargets = { src: null, list: [] };
function parseTargets() {
    const src = String(settings().tagTargets ?? '');
    if (parsedTargets.src !== src) {
        parsedTargets = {
            src,
            list: src.split(/[\n,]/).map(x => x.trim()).filter(Boolean),
        };
    }
    return parsedTargets.list;
}

// 메시지 객체 → { raw, src, tagItems, missing } : 원문과 대상 목록이 같으면 재사용
const rawTargetCache = new WeakMap();

function extractRawTargets(msg, entries) {
    const raw = String(msg.mes ?? '');
    const src = parsedTargets.src;
    const cached = rawTargetCache.get(msg);
    if (cached && cached.raw === raw && cached.src === src) return cached;

    const tagItems = [];
    const missing = []; // 원문에서 못 찾은 항목 → 화면(DOM)에서 찾아봄
    for (const entry of entries) {
        if (!/^[\w:-]+$/.test(entry)) {
            missing.push(entry);
            continue;
        }
        const tag = escapeRegex(entry);
        const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}\\s*>`, 'gi');
        let found = false;
        for (const m of raw.matchAll(re)) {
            const text = htmlToText(m[1]);
            if (text) {
                tagItems.push({ label: `<${entry}>`, source: text });
                found = true;
            }
        }
        // 원문에 여는 태그조차 없으면 화면에도 없음 → DOM 검색 생략
        if (!found && raw.toLowerCase().includes(`<${entry.toLowerCase()}`)) missing.push(entry);
    }
    const result = { raw, src, tagItems, missing };
    rawTargetCache.set(msg, result);
    return result;
}

function getMesEl(mesId) {
    return document.querySelector(`#chat .mes[mesid="${mesId}"]`);
}

/** 원본 메시지(chat[mesId].mes)에서 대상 태그 내용을 꺼냄 */
function extractTargets(mesId) {
    const msg = ctx().chat?.[mesId];
    if (!msg) return [];
    const { tagItems, missing } = extractRawTargets(msg, parseTargets());
    if (!missing.length) return tagItems;

    const items = [...tagItems];
    const textEl = getMesEl(mesId)?.querySelector('.mes_text');
    for (const entry of missing) {
        // CSS 선택자(예: div.choices)는 렌더링된 화면에서 텍스트만 읽음
        if (!textEl) break;
        let els = [];
        try {
            els = [...textEl.querySelectorAll(entry)];
        } catch {
            els = [];
        }
        els = els.filter(el => !els.some(other => other !== el && other.contains(el)));
        for (const el of els) {
            const text = htmlToText(el.innerHTML);
            if (text) items.push({ label: entry, source: text });
        }
    }
    return items;
}

function cacheKey(source) {
    return hashStr(`${settings().language}\u0001${source}`);
}

function getStore(mesId, create = false) {
    const msg = ctx().chat?.[mesId];
    if (!msg) return null;
    if (!create) return msg.extra?.[MODULE] ?? null;
    msg.extra ??= {};
    msg.extra[MODULE] ??= { cache: {} };
    msg.extra[MODULE].cache ??= {};
    return msg.extra[MODULE];
}

function pruneCache(store) {
    const keys = Object.keys(store.cache);
    const overflow = keys.length - 50;
    for (let i = 0; i < overflow; i++) delete store.cache[keys[i]];
}

async function runTagTranslation(mesId, force) {
    const items = extractTargets(mesId);
    if (!items.length) return [];

    const saveOn = settings().saveTranslations;
    const store = saveOn ? getStore(mesId, true) : null;
    const results = [];
    let changed = false;
    let lastError = null;

    for (const item of items) {
        const key = cacheKey(item.source);
        let text = force || !store ? null : store.cache[key];
        if (!text) {
            try {
                text = await translateText(item.source, { useCache: !force });
                if (store) {
                    store.cache[key] = text;
                    changed = true;
                }
            } catch (e) {
                lastError = e;
                console.error(LOG, e);
            }
        }
        results.push({ label: item.label, text: text ?? null });
    }

    if (store) pruneCache(store);
    if (changed) saveChatSoon();
    if (lastError && results.every(r => !r.text)) throw lastError;
    return results;
}

function translateTags(mesId, { force = false } = {}) {
    if (!force && inflight.has(mesId)) return inflight.get(mesId);
    const promise = runTagTranslation(mesId, force).finally(() => {
        if (inflight.get(mesId) === promise) inflight.delete(mesId);
        updateButton(mesId);
    });
    inflight.set(mesId, promise);
    updateButton(mesId);
    return promise;
}

/* ------------------------------------------------------------------ */
/* 메시지 버튼                                                          */
/* ------------------------------------------------------------------ */

const MES_BUTTON_HTML = `<div title="선택지 번역" class="mes_button sttr_mes_button fa-solid ${BUTTON_ICON} interactable" tabindex="0"></div>`;

function insertButton(buttonsEl) {
    if (!buttonsEl || buttonsEl.querySelector(':scope > .sttr_mes_button')) return;
    const edit = buttonsEl.querySelector(':scope > .mes_edit');
    if (edit) edit.insertAdjacentHTML('beforebegin', MES_BUTTON_HTML);
    else buttonsEl.insertAdjacentHTML('beforeend', MES_BUTTON_HTML);
}

function ensureMessageButtons() {
    insertButton(document.querySelector('#message_template .mes_buttons'));
    document.querySelectorAll('#chat .mes .mes_buttons').forEach(insertButton);
}

/** 메시지에 대상 태그가 있을 때만 버튼을 보이고, 번역 상태를 아이콘에 반영 */
function isReady(mesId, items = extractTargets(mesId)) {
    if (!settings().saveTranslations) return false;
    const store = getStore(mesId);
    return items.length > 0 && !!store && items.every(it => store.cache?.[cacheKey(it.source)]);
}

function updateButton(mesId) {
    scheduleDockUpdate();
    const mesEl = getMesEl(mesId);
    if (!mesEl) return;
    const items = extractTargets(mesId);
    mesEl.classList.toggle('sttr-has-target', items.length > 0);

    const btn = mesEl.querySelector('.sttr_mes_button');
    if (!btn) return;
    const isBusy = inflight.has(mesId);
    btn.classList.toggle(BUTTON_ICON, !isBusy);
    btn.classList.toggle('fa-spinner', isBusy);
    btn.classList.toggle('fa-spin', isBusy);

    const ready = isReady(mesId, items);
    btn.classList.toggle('sttr-ready', ready && !isBusy);
    btn.title = isBusy ? '번역 중…' : ready ? '선택지 번역 보기' : '선택지 번역';
}

function updateAllButtons() {
    ensureMessageButtons();
    setTimeout(() => hookChatIframes(), 1500);
    document.querySelectorAll('#chat .mes[mesid]').forEach(el => {
        updateButton(Number(el.getAttribute('mesid')));
    });
}

function onMessageButtonClick(e) {
    const btn = e.target.closest('.sttr_mes_button');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const mesId = Number(btn.closest('.mes')?.getAttribute('mesid'));
    if (Number.isNaN(mesId)) return;

    // 같은 메시지의 팝업이 열려 있으면 닫기 (토글)
    if (!popup.hidden && popupState?.kind === 'tag' && popupState.mesId === mesId) {
        hidePopup();
        return;
    }
    openTagPopup(mesId, rectToObj(btn.getBoundingClientRect()));
}

function onCharacterMessageRendered(mesId) {
    if (Number.isNaN(mesId)) return;
    setTimeout(() => hookChatIframes(getMesEl(mesId)), 1500);
    ensureMessageButtons();
    updateButton(mesId);

    const s = settings();
    const c = ctx();
    const isLatest = mesId === (c.chat?.length ?? 0) - 1;
    if (!s.enabled || !isLatest || s.autoMode === 'off') return;
    if (!extractTargets(mesId).length) return;

    if (s.autoMode === 'popup') {
        openTagPopup(mesId, autoAnchor(), { silentIfEmpty: true, keepCollapsed: true });
    } else {
        translateTags(mesId).catch(e => console.warn(LOG, '미리 번역 실패', e));
    }
}

/* ------------------------------------------------------------------ */
/* 플로팅 버튼 + 팝업                                                    */
/* ------------------------------------------------------------------ */

let fab = null;
let popup = null;
let fabState = null;     // { text, anchor, box }
let popupState = null;   // { kind: 'sel', text, box } | { kind: 'tag', mesId, box }
let popupToken = 0;
let fabPressed = false;
let selTimer = null;

const coarsePointer = window.matchMedia?.('(pointer: coarse)');
const hasTouch = 'ontouchstart' in window;
function isTouchDevice() {
    return hasTouch || !!coarsePointer?.matches;
}

function rectToObj(r) {
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
}

/** 입력창 바로 위, 채팅 영역 가운데 */
function bottomAnchor() {
    const form = document.getElementById('send_form')?.getBoundingClientRect();
    const chat = document.getElementById('chat')?.getBoundingClientRect();
    const top = form?.top ?? window.innerHeight - 80;
    return {
        left: chat?.left ?? 0,
        right: chat?.right ?? window.innerWidth,
        top,
        bottom: top,
        center: true,
    };
}

function createFloatingUI() {
    fab = document.createElement('div');
    fab.id = 'sttr_fab';
    fab.className = 'sttr-fab';
    fab.title = '선택한 텍스트 번역';
    fab.hidden = true;
    fab.innerHTML = '<i class="fa-solid fa-language"></i><span>번역</span>';
    fab.addEventListener('pointerdown', e => {
        fabPressed = true;
        e.preventDefault();
        e.stopPropagation();
    });
    fab.addEventListener('mousedown', e => e.preventDefault());
    fab.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        setTimeout(() => { fabPressed = false; }, 300);
        translateSelection(false);
        if (isTouchDevice()) {
            try {
                selectionWindow.getSelection()?.removeAllRanges();
            } catch { /* noop */ }
        }
    });
    document.body.append(fab);

    popup = document.createElement('div');
    popup.id = 'sttr_popup';
    popup.className = 'sttr-popup';
    popup.hidden = true;
    popup.innerHTML = `
        <div class="sttr-popup-head" title="눌러서 접기/펼치기">
            <span class="sttr-popup-title-wrap">
                <i class="fa-solid fa-chevron-down sttr-collapse-icon"></i>
                <span class="sttr-popup-title"></span>
            </span>
            <span class="sttr-popup-actions">
                <i class="fa-solid fa-copy sttr-act" data-act="copy" title="복사"></i>
                <i class="fa-solid fa-rotate sttr-act" data-act="retry" title="다시 번역"></i>
                <i class="fa-solid fa-xmark sttr-act" data-act="close" title="닫기"></i>
            </span>
        </div>
        <div class="sttr-popup-body"></div>`;
    popup.addEventListener('click', onPopupAction);
    document.body.append(popup);

    // 드래그 번역 팝업만 바깥 클릭으로 닫힘. 선택지 팝업은 답장을 쓰는 동안 계속 떠 있음.
    document.addEventListener('pointerdown', e => {
        if (popup.hidden || popupState?.kind !== 'sel') return;
        if (popup.contains(e.target) || fab.contains(e.target)) return;
        hidePopup();
    }, true);
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            hidePopup();
            hideFab();
        }
    });
    document.addEventListener('selectionchange', queueSelectionCheck);
    window.addEventListener('blur', () => {
        setTimeout(() => {
            const active = document.activeElement;
            if (active?.tagName === 'IFRAME' && active.closest('#chat')) hookIframe(active);
        }, 0);
    });
    // 모바일은 텍스트를 길게 누르거나 주소창이 접힐 때 scroll/resize가 자주 생김 → 숨기지 않고 다시 계산
    // 모바일은 주소창이 접힐 때마다 resize가 연달아 옴 → 프레임당 한 번만 처리
    let resizeRaf = 0;
    window.addEventListener('resize', () => {
        if (resizeRaf) return;
        resizeRaf = requestAnimationFrame(() => {
            resizeRaf = 0;
            if (!fab.hidden) queueSelectionCheck();
            applyDockPos();
            placePopup();
        });
    }, { passive: true });

    // 스크롤 중에는 아무 계산도 하지 않고, 멈춘 뒤 한 번만 처리
    let scrollTimer = null;
    document.getElementById('chat')?.addEventListener('scroll', () => {
        if (!fab.hidden && !isTouchDevice()) hideFab();
        if (scrollTimer) return;
        scrollTimer = setTimeout(() => {
            scrollTimer = null;
            if (fabState && !isTouchDevice()) queueSelectionCheck();
            if (dock && !dock.hidden && settings().dockTranslate) scheduleDockUpdate();
        }, 200);
    }, { passive: true });
}

function queueSelectionCheck() {
    clearTimeout(selTimer);
    selTimer = setTimeout(onSelectionChange, 250);
}

/**
 * closest()는 셰도 DOM 경계를 넘지 못함.
 * 일부 HTML 렌더링 확장은 꾸민 영역을 셰도 DOM에 넣기 때문에, 경계를 넘어 위로 올라가며 찾음.
 */
function closestComposed(el, selector) {
    while (el) {
        const found = el.closest(selector);
        if (found) return found;
        const root = el.getRootNode?.();
        el = root && root !== document && root.host ? root.host : null;
    }
    return null;
}

/* ---- iframe 안의 선택 ----
 * 상태창 같은 꾸민 HTML을 iframe으로 그려 주는 확장이 많음.
 * iframe 안에서 드래그하면 바깥 문서에는 선택 이벤트가 오지 않으므로,
 * 사용자가 iframe을 건드린 순간에만 그 iframe에 감시를 붙임(평소엔 비용 없음).
 */
const hookedFrameDocs = new WeakSet();
let selectionWindow = window; // 마지막으로 선택이 일어난 창

function hookIframe(iframe) {
    const attach = () => {
        let doc;
        try {
            doc = iframe.contentDocument; // 다른 출처(sandbox 등)면 접근 불가 → 지원 불가
        } catch {
            return;
        }
        if (!doc || hookedFrameDocs.has(doc)) return;
        hookedFrameDocs.add(doc);
        doc.addEventListener('selectionchange', queueSelectionCheck);
        doc.addEventListener('pointerdown', () => {
            if (popupState?.kind === 'sel') hidePopup();
        }, true);
    };
    attach();
    if (!iframe.dataset.sttrHooked) {
        iframe.dataset.sttrHooked = '1';
        iframe.addEventListener('load', attach);
    }
}

function hookChatIframes(root = document.getElementById('chat')) {
    if (!settings().selectionEnabled) return;
    root?.querySelectorAll('iframe').forEach(hookIframe);
}

/** 바깥 문서 또는 채팅 안 iframe 중 실제로 글이 선택된 곳을 찾음 */
function findActiveSelection() {
    const main = window.getSelection();
    if (main && !main.isCollapsed && main.rangeCount && main.toString().trim()) {
        return { sel: main, win: window, frame: null };
    }
    for (const frame of document.querySelectorAll('#chat iframe')) {
        let win;
        try {
            win = frame.contentWindow;
            const sel = win?.getSelection();
            if (sel && !sel.isCollapsed && sel.rangeCount && sel.toString().trim()) {
                return { sel, win, frame };
            }
        } catch {
            /* 접근할 수 없는 iframe */
        }
    }
    return null;
}

function offsetRect(r, frame) {
    if (!frame) return r;
    const fr = frame.getBoundingClientRect();
    const dx = fr.left + frame.clientLeft;
    const dy = fr.top + frame.clientTop;
    return { left: r.left + dx, right: r.right + dx, top: r.top + dy, bottom: r.bottom + dy };
}

function onSelectionChange() {
    const s = settings();
    if (!s.enabled || !s.selectionEnabled) return hideFab();

    const found = findActiveSelection();
    if (!found) {
        if (!fabPressed) hideFab();
        return;
    }
    const { sel, win, frame } = found;
    const text = sel.toString().trim();

    const range = sel.getRangeAt(0);
    const node = range.commonAncestorContainer;
    // iframe 안이면 바깥 문서 기준으로는 iframe 요소 자체로 위치를 판단
    const elem = frame ?? (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement);
    if (!elem) return hideFab();
    if (closestComposed(elem, '#sttr_popup, #sttr_fab')) return;
    if (!frame && closestComposed(elem, 'textarea, input, [contenteditable="true"]')) return hideFab();
    if (s.selectionOnlyInChat && !closestComposed(elem, '#chat')) return hideFab();

    selectionWindow = win;
    const rects = range.getClientRects();
    const anchor = offsetRect(rects.length ? rects[rects.length - 1] : range.getBoundingClientRect(), frame);
    showFab(text, anchor, offsetRect(range.getBoundingClientRect(), frame));
}

function showFab(text, anchor, box) {
    const touch = isTouchDevice();
    fabState = { text, anchor: rectToObj(anchor), box: touch ? bottomAnchor() : rectToObj(box) };
    fab.hidden = false;
    fab.classList.toggle('sttr-fab-touch', touch);
    const w = fab.offsetWidth;
    const h = fab.offsetHeight;
    let left;
    let top;
    if (touch) {
        const b = bottomAnchor();
        left = b.left + ((b.right - b.left) - w) / 2;
        top = b.top - h - 12;
    } else {
        left = anchor.right - w;
        top = anchor.bottom + 8;
        if (top + h > window.innerHeight - 8) top = anchor.top - h - 8;
    }
    fab.style.left = `${Math.min(Math.max(8, left), window.innerWidth - w - 8)}px`;
    fab.style.top = `${Math.min(Math.max(8, top), window.innerHeight - h - 8)}px`;
}

function hideFab() {
    if (fab) fab.hidden = true;
}

function profileLabel() {
    const s = settings();
    if (!s.profileId) return '메인 API';
    return getProfiles().find(p => p.id === s.profileId)?.name ?? '알 수 없는 프로필';
}

let popupCollapsed = false;

function setPopupCollapsed(collapsed) {
    popupCollapsed = collapsed;
    popup.classList.toggle('sttr-collapsed', collapsed);
    popup.querySelector('.sttr-popup-head').setAttribute('aria-expanded', String(!collapsed));
    placePopup();
}

/** keepCollapsed: 자동 팝업처럼 사용자가 직접 연 게 아니면 마지막 접기 상태 유지 */
function openPopupShell(state, title, { keepCollapsed = false } = {}) {
    hideFab();
    popupState = state;
    popup.hidden = false;
    setPopupCollapsed(keepCollapsed && state.kind === 'tag' ? popupCollapsed : false);
    popup.classList.toggle('sttr-pinned', state.kind === 'tag');
    popup.querySelector('.sttr-popup-title').textContent = `${title} (${profileLabel()} → ${settings().language})`;
    setPopupContent('loading');
    return ++popupToken;
}

/**
 * @param {'loading'|'ok'|'error'} state
 * @param {string | {label: string, text: string|null}[]} content
 */
function setPopupContent(state, content = '') {
    const body = popup.querySelector('.sttr-popup-body');
    body.classList.toggle('sttr-loading', state === 'loading');
    body.classList.toggle('sttr-error', state === 'error');
    body.replaceChildren();
    popup.dataset.result = '';

    if (state === 'loading') {
        body.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 번역 중…';
    } else if (state === 'error' || typeof content === 'string') {
        body.textContent = content;
        if (state === 'ok') popup.dataset.result = content;
    } else {
        const multiple = content.length > 1;
        for (const item of content) {
            const section = document.createElement('div');
            section.className = 'sttr-section';
            if (multiple) {
                const label = document.createElement('div');
                label.className = 'sttr-section-label';
                label.textContent = item.label;
                section.append(label);
            }
            const text = document.createElement('div');
            text.className = item.text ? 'sttr-section-text' : 'sttr-section-text sttr-error';
            text.textContent = item.text ?? '이 부분은 번역에 실패했어요. 다시 번역을 눌러 주세요.';
            section.append(text);
            body.append(section);
        }
        popup.dataset.result = content.map(c => c.text).filter(Boolean).join('\n\n');
    }
    placePopup();
}

function placePopup() {
    const box = popupState?.box;
    if (!box || !popup || popup.hidden) return;
    const w = popup.offsetWidth;
    const h = popup.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left;
    let top;

    // 독 버튼: 버튼 옆에 띄워서 독을 가리지 않게
    const fitsLeft = box.side && box.left - w - 8 >= 8;
    const fitsRight = box.side && box.right + 8 + w <= vw - 8;
    if (fitsLeft || fitsRight) {
        left = fitsLeft ? box.left - w - 8 : box.right + 8;
        top = box.bottom - h;
    } else {
        if (box.center) left = box.left + ((box.right - box.left) - w) / 2;
        else if (box.side) left = box.right - w;
        else left = box.left;

        top = box.bottom + 8;
        if (box.center || box.side || top + h > vh - 8) {
            const above = box.top - h - 8;
            top = above >= 8 ? above : vh - h - 8;
        }
    }
    popup.style.left = `${Math.min(Math.max(8, left), vw - w - 8)}px`;
    popup.style.top = `${Math.min(Math.max(8, top), vh - h - 8)}px`;
}

function hidePopup() {
    if (!popup || popup.hidden) return;
    popup.hidden = true;
    popupToken++;
}

async function translateSelection(force) {
    const state = force ? popupState : fabState;
    if (!state?.text) return;
    const token = openPopupShell({ kind: 'sel', text: state.text, box: state.box }, '번역');
    try {
        const out = await translateText(state.text, { useCache: !force });
        if (token === popupToken) setPopupContent('ok', out);
    } catch (e) {
        console.error(LOG, e);
        if (token === popupToken) setPopupContent('error', errMsg(e));
    }
}

async function openTagPopup(mesId, box, { force = false, silentIfEmpty = false, keepCollapsed = false } = {}) {
    const items = extractTargets(mesId);
    if (!items.length) {
        if (!silentIfEmpty) toastr.info('이 메시지에서 번역할 태그를 찾지 못했어요. 설정의 대상 태그를 확인해 주세요.');
        return;
    }
    const title = [...new Set(items.map(i => i.label))].join(', ');
    const token = openPopupShell({ kind: 'tag', mesId, box }, title, { keepCollapsed });
    try {
        const results = await translateTags(mesId, { force });
        if (token === popupToken) setPopupContent('ok', results);
    } catch (e) {
        if (token === popupToken) setPopupContent('error', errMsg(e));
    }
}

async function onPopupAction(e) {
    const act = e.target.closest('.sttr-act')?.dataset.act;
    if (!act) {
        if (e.target.closest('.sttr-popup-head')) setPopupCollapsed(!popupCollapsed);
        return;
    }
    if (act !== 'close' && popupCollapsed) setPopupCollapsed(false);
    if (act === 'close') hidePopup();
    if (act === 'retry') {
        if (popupState?.kind === 'tag') openTagPopup(popupState.mesId, popupState.box, { force: true, keepCollapsed: true });
        else if (popupState?.text) translateSelection(true);
        else showDiagnostics();
    }
    if (act === 'copy') {
        const text = popup.dataset.result;
        if (text && await copyToClipboard(text)) toastr.success('번역을 복사했어요.');
    }
}

/* ------------------------------------------------------------------ */
/* 플로팅 독: 선택지 번역 + 메시지 이동                                    */
/* ------------------------------------------------------------------ */

let dock = null;
let dockRaf = 0;
let navLast = { top: null, time: 0 };

function createDock() {
    dock = document.createElement('div');
    dock.id = 'sttr_dock';
    dock.className = 'sttr-dock';
    dock.hidden = true;
    dock.innerHTML = `
        <div class="sttr-dock-grip" title="끌어서 위치 옮기기"><i class="fa-solid fa-grip-lines"></i></div>
        <button type="button" class="sttr-dock-btn" data-dock="up" title="이전 메시지 (길게 누르면 맨 위)"><i class="fa-solid fa-chevron-up"></i></button>
        <button type="button" class="sttr-dock-btn" data-dock="tr" title="선택지 번역"><i class="fa-solid ${BUTTON_ICON}"></i></button>
        <button type="button" class="sttr-dock-btn" data-dock="down" title="다음 메시지 (길게 누르면 맨 아래)"><i class="fa-solid fa-chevron-down"></i></button>`;
    mountDock();

    // 실리태번 모바일은 화면을 좌우로 쓸면 답변을 넘기는 제스처가 있음(문서 전체에서 터치를 감시).
    // 막대를 끄는 동작이 그쪽으로 전달되면 제스처 계산이 같이 돌거나 스와이프로 오인될 수 있어 차단.
    dock.setAttribute('data-swipe-ignore', 'true');
    for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
        dock.addEventListener(type, e => e.stopPropagation(), { passive: true });
    }

    setupDockDrag(dock.querySelector('.sttr-dock-grip'));
    setupNavButton(dock.querySelector('[data-dock="up"]'), -1);
    setupNavButton(dock.querySelector('[data-dock="down"]'), 1);
    dock.querySelector('[data-dock="tr"]').addEventListener('click', onDockTranslate);

    applyDockPos();
    scheduleDockUpdate();
}

/** #sheld(채팅 영역) 안에 넣고, 불가능하면 body에 고정 위치로 */
function mountDock() {
    const sheld = document.getElementById('sheld');
    const usable = sheld && getComputedStyle(sheld).position !== 'static';
    (usable ? sheld : document.body).append(dock);
    dock.classList.toggle('sttr-dock-in-sheld', !!usable);
}

/** 독 좌표의 기준 영역 */
function dockContainerRect() {
    if (dock?.parentElement && dock.parentElement !== document.body) {
        return dock.parentElement.getBoundingClientRect();
    }
    return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight, width: window.innerWidth, height: window.innerHeight };
}

function hasOpenChat() {
    return !!document.querySelector('#chat .mes');
}

function isDockTranslateVisible() {
    return !!dock && !dock.hidden && settings().dockTranslate;
}

function scheduleDockUpdate() {
    if (!dock || dockRaf) return;
    dockRaf = requestAnimationFrame(() => {
        dockRaf = 0;
        updateDock();
    });
}

function updateDock() {
    const s = settings();
    const wasHidden = dock.hidden;
    if (!dock.isConnected) mountDock();
    dock.hidden = !(s.enabled && s.dockEnabled && (s.dockTranslate || s.dockNav) && hasOpenChat());
    if (wasHidden && !dock.hidden) applyDockPos();
    dock.querySelector('[data-dock="tr"]').hidden = !s.dockTranslate;
    dock.querySelector('[data-dock="up"]').hidden = !s.dockNav;
    dock.querySelector('[data-dock="down"]').hidden = !s.dockNav;
    if (dock.hidden || !s.dockTranslate) return;

    const btn = dock.querySelector('[data-dock="tr"]');
    const icon = btn.querySelector('i');
    const mesId = findTranslateTarget();
    const isBusy = mesId !== null && inflight.has(mesId);

    icon.className = isBusy ? 'fa-solid fa-spinner fa-spin' : `fa-solid ${BUTTON_ICON}`;
    btn.classList.toggle('sttr-dim', mesId === null);
    btn.classList.toggle('sttr-ready', mesId !== null && !isBusy && isReady(mesId));
    btn.title = mesId === null ? '번역할 선택지가 없어요' : `선택지 번역 (#${mesId})`;
}

/** 화면에 보이는 메시지 중 가장 아래쪽에서 대상 태그가 있는 것, 없으면 최근 메시지에서 찾음 */
function findTranslateTarget() {
    const chatEl = document.getElementById('chat');
    if (!chatEl) return null;
    const cr = chatEl.getBoundingClientRect();
    const mesEls = [...chatEl.querySelectorAll('.mes[mesid]')];

    for (let i = mesEls.length - 1; i >= 0; i--) {
        const r = mesEls[i].getBoundingClientRect();
        if (r.top >= cr.bottom) continue;  // 화면 아래
        if (r.bottom <= cr.top) break;     // 화면 위 → 더 볼 필요 없음
        const id = Number(mesEls[i].getAttribute('mesid'));
        if (extractTargets(id).length) return id;
    }

    const chat = ctx().chat ?? [];
    for (let id = chat.length - 1; id >= Math.max(0, chat.length - 50); id--) {
        if (extractTargets(id).length) return id;
    }
    return null;
}

function dockAnchor() {
    const r = dock.querySelector('[data-dock="tr"]').getBoundingClientRect();
    return { ...rectToObj(r), side: true };
}

function autoAnchor() {
    return isDockTranslateVisible() ? dockAnchor() : bottomAnchor();
}

function onDockTranslate(e) {
    e.preventDefault();
    const mesId = findTranslateTarget();
    if (mesId === null) {
        toastr.info('번역할 선택지가 있는 메시지가 없어요.');
        return;
    }
    if (!popup.hidden && popupState?.kind === 'tag' && popupState.mesId === mesId) {
        hidePopup();
        return;
    }
    openTagPopup(mesId, dockAnchor());
}

/* ---- 위치 & 드래그 ---- */

function defaultDockPos() {
    const cr = dockContainerRect();
    const form = document.getElementById('form_sheld') ?? document.getElementById('send_form');
    const formTop = form?.getBoundingClientRect().top ?? cr.bottom - 60;
    return { right: 10, bottom: Math.max(10, cr.bottom - formTop + 10) };
}

function setDockPos(pos) {
    const cr = dockContainerRect();
    const w = dock.offsetWidth || 46;
    const h = dock.offsetHeight || 160;
    const right = Math.min(Math.max(4, Number(pos?.right) || 0), Math.max(4, cr.width - w - 4));
    const bottom = Math.min(Math.max(4, Number(pos?.bottom) || 0), Math.max(4, cr.height - h - 4));
    dock.style.right = `${right}px`;
    dock.style.bottom = `${bottom}px`;
    return { right, bottom };
}

function applyDockPos() {
    if (!dock) return;
    setDockPos(settings().dockPos ?? defaultDockPos());
}

/**
 * 드래그 중에는 transform만 바꿈(GPU 합성만 일어나고 레이아웃 계산 없음).
 * 크기·경계는 누르는 순간 한 번만 측정하고, 손을 뗄 때 right/bottom으로 확정.
 */
function setupDockDrag(grip) {
    let drag = null;
    let raf = 0;

    const paint = () => {
        raf = 0;
        if (drag) dock.style.transform = `translate3d(${drag.dx}px, ${drag.dy}px, 0)`;
    };

    grip.addEventListener('pointerdown', e => {
        e.preventDefault();
        e.stopPropagation();
        grip.setPointerCapture(e.pointerId);
        const cr = dockContainerRect();
        const r = dock.getBoundingClientRect();
        const right = cr.right - r.right;
        const bottom = cr.bottom - r.bottom;
        drag = {
            x0: e.clientX,
            y0: e.clientY,
            right,
            bottom,
            dx: 0,
            dy: 0,
            // right = right0 - dx 가 [4, 폭 - w - 4] 안에 있도록
            minDx: right - (cr.width - r.width - 4),
            maxDx: right - 4,
            minDy: bottom - (cr.height - r.height - 4),
            maxDy: bottom - 4,
        };
        dock.classList.add('sttr-dragging');
    });

    grip.setAttribute('data-swipe-ignore', 'true');

    grip.addEventListener('pointermove', e => {
        if (!drag) return;
        e.stopPropagation();
        drag.dx = Math.min(Math.max(e.clientX - drag.x0, drag.minDx), drag.maxDx);
        drag.dy = Math.min(Math.max(e.clientY - drag.y0, drag.minDy), drag.maxDy);
        if (!raf) raf = requestAnimationFrame(paint);
    });

    const end = () => {
        if (!drag) return;
        cancelAnimationFrame(raf);
        raf = 0;
        const moved = drag.dx !== 0 || drag.dy !== 0;
        const pos = { right: drag.right - drag.dx, bottom: drag.bottom - drag.dy };
        drag = null;
        dock.style.transform = '';
        dock.classList.remove('sttr-dragging');
        if (moved) {
            dock.style.right = `${pos.right}px`;
            dock.style.bottom = `${pos.bottom}px`;
            settings().dockPos = pos;
            saveSettings();
            placePopup();
        }
    };
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
    grip.addEventListener('lostpointercapture', end);
}

/* ---- 진단 ---- */

function describeEl(el) {
    if (!el) return '(없음)';
    const id = el.id ? `#${el.id}` : '';
    const cls = typeof el.className === 'string' && el.className.trim()
        ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.')
        : '';
    return `${el.tagName.toLowerCase()}${id}${cls}`;
}

function dockDiagnostics() {
    const s = settings();
    const lines = [];
    lines.push(`화면: ${window.innerWidth}x${window.innerHeight}, 터치: ${isTouchDevice()}`);
    lines.push(`설정: enabled=${s.enabled}, dockEnabled=${s.dockEnabled}, 번역=${s.dockTranslate}, 이동=${s.dockNav}`);
    lines.push(`저장된 위치: ${JSON.stringify(s.dockPos)}`);
    lines.push(`채팅 메시지 감지: ${hasOpenChat()}`);
    const dup = countDuplicates();
    lines.push(`설정 패널 ${dup.panels}개, 플로팅 막대 ${dup.docks}개${dup.panels > 1 || dup.docks > 1 ? ' ← 중복 로드! 예전 폴더를 지워 주세요' : ' (정상)'}`);
    if (!dock) {
        lines.push('독 요소: 생성되지 않음');
        return lines.join('\n');
    }
    updateDock();
    const cs = getComputedStyle(dock);
    const r = dock.getBoundingClientRect();
    lines.push(`부모: ${describeEl(dock.parentElement)}, 연결됨: ${dock.isConnected}`);
    lines.push(`hidden=${dock.hidden}, display=${cs.display}, visibility=${cs.visibility}, opacity=${cs.opacity}, position=${cs.position}, z=${cs.zIndex}`);
    lines.push(`right/bottom: ${dock.style.right} / ${dock.style.bottom}`);
    lines.push(`실제 위치: x=${Math.round(r.left)}, y=${Math.round(r.top)}, ${Math.round(r.width)}x${Math.round(r.height)}`);
    if (r.width && r.height) {
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const top = document.elementFromPoint(cx, cy);
        lines.push(`그 위치의 맨 위 요소: ${describeEl(top)}${dock.contains(top) ? ' (독 자신 → 정상)' : ' ← 이게 가리고 있음'}`);
    }
    const sheld = document.getElementById('sheld');
    if (sheld) {
        const sc = getComputedStyle(sheld);
        lines.push(`#sheld: position=${sc.position}, overflow=${sc.overflow}, z=${sc.zIndex}`);
    }
    return lines.join('\n');
}

function showDiagnostics() {
    const text = dockDiagnostics();
    console.log(LOG, text);
    openPopupShell({ kind: 'sel', text: '', box: bottomAnchor() }, '플로팅 버튼 진단');
    setPopupContent('ok', text);
}

/* ---- 메시지 단위 이동 ---- */

function scrollBehavior() {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}

function messageTops(chatEl) {
    const base = chatEl.getBoundingClientRect().top - chatEl.scrollTop;
    return [...chatEl.querySelectorAll('.mes[mesid]')]
        .filter(el => el.offsetParent !== null)
        .map(el => el.getBoundingClientRect().top - base);
}

function scrollChatTo(chatEl, top) {
    const max = chatEl.scrollHeight - chatEl.clientHeight;
    const target = Math.min(Math.max(0, top), Math.max(0, max));
    navLast = { top: target, time: Date.now() };
    chatEl.scrollTo({ top: target, behavior: scrollBehavior() });
}

/** dir: -1 이전 메시지 시작점, +1 다음 메시지 시작점 */
function navigateMessage(dir) {
    const chatEl = document.getElementById('chat');
    if (!chatEl) return;
    const tops = messageTops(chatEl);
    if (!tops.length) return;

    // 부드러운 스크롤 중에 연달아 누르면 진행 중인 목표 위치를 기준으로 계산
    const recent = navLast.top !== null && Date.now() - navLast.time < 800;
    const current = recent ? navLast.top : chatEl.scrollTop;
    const pad = 6;

    if (dir > 0) {
        const next = tops.find(t => t - pad > current + 2);
        scrollChatTo(chatEl, next === undefined ? chatEl.scrollHeight : next - pad);
    } else {
        const prev = [...tops].reverse().find(t => t - pad < current - 2);
        scrollChatTo(chatEl, prev === undefined ? 0 : prev - pad);
    }
}

function navigateEdge(dir) {
    const chatEl = document.getElementById('chat');
    if (chatEl) scrollChatTo(chatEl, dir > 0 ? chatEl.scrollHeight : 0);
}

function setupNavButton(btn, dir) {
    let timer = null;
    let longPressed = false;
    btn.addEventListener('pointerdown', () => {
        longPressed = false;
        clearTimeout(timer);
        timer = setTimeout(() => {
            longPressed = true;
            navigateEdge(dir);
        }, 500);
    });
    const cancel = () => clearTimeout(timer);
    btn.addEventListener('pointerup', cancel);
    btn.addEventListener('pointerleave', cancel);
    btn.addEventListener('pointercancel', cancel);
    btn.addEventListener('contextmenu', e => e.preventDefault());
    btn.addEventListener('click', e => {
        e.preventDefault();
        if (longPressed) {
            longPressed = false;
            return;
        }
        navigateMessage(dir);
    });
}

/* ------------------------------------------------------------------ */
/* 마법봉(확장 메뉴) 버튼                                                 */
/* ------------------------------------------------------------------ */

function addWandMenuItems() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('sttr_wand_translate')) return;

    const item = document.createElement('div');
    item.id = 'sttr_wand_translate';
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.innerHTML = `<div class="fa-solid ${BUTTON_ICON} extensionsMenuExtensionButton"></div><span>선택지 번역</span>`;
    item.addEventListener('click', () => {
        const mesId = findTranslateTarget();
        if (mesId === null) {
            toastr.info('번역할 선택지가 있는 메시지가 없어요.');
            return;
        }
        // 마법봉 메뉴가 닫힌 뒤에 팝업을 띄움
        setTimeout(() => openTagPopup(mesId, autoAnchor()), 50);
    });
    menu.append(item);
    applyWandVisibility();
}

function applyWandVisibility() {
    const item = document.getElementById('sttr_wand_translate');
    if (!item) return;
    const s = settings();
    item.style.display = s.enabled && s.showWandItem ? '' : 'none';
}

/* ------------------------------------------------------------------ */
/* 설정 UI                                                              */
/* ------------------------------------------------------------------ */

function applyBodyClasses() {
    const s = settings();
    applyWandVisibility();
    document.body.classList.toggle('sttr-no-mes-btn', !s.enabled || !s.showMessageButton);
    if (!s.enabled || !s.selectionEnabled) hideFab();
    scheduleDockUpdate();
}

function refreshProfileSelect() {
    const sel = document.getElementById('sttr_profile');
    const hint = document.getElementById('sttr_profile_hint');
    if (!sel) return;
    const s = settings();
    const profiles = [...getProfiles()].sort((a, b) => String(a.name).localeCompare(String(b.name)));

    sel.innerHTML = '';
    sel.append(new Option('현재 메인 API 사용', ''));
    for (const p of profiles) {
        const detail = [p.api, p.model].filter(Boolean).join(' / ');
        sel.append(new Option(detail ? `${p.name} (${detail})` : p.name, p.id));
    }
    if (s.profileId && !profiles.some(p => p.id === s.profileId)) {
        sel.append(new Option('⚠ 삭제되었거나 찾을 수 없는 프로필', s.profileId));
    }
    sel.value = s.profileId;

    if (hint) {
        hint.textContent = profiles.length
            ? '번역에만 쓸 모델을 고를 수 있어요. 지금 채팅 중인 연결은 바뀌지 않습니다.'
            : 'Connection Manager에 저장된 프로필이 없어요. API 연결 패널에서 프로필을 만들면 여기에 나타납니다.';
    }
}

function bind(id, key, { type = 'text', after } = {}) {
    const el = document.getElementById(id);
    if (!el) return;
    const s = settings();
    if (type === 'checkbox') el.checked = !!s[key];
    else el.value = s[key] ?? '';

    el.addEventListener(type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input', () => {
        if (type === 'checkbox') s[key] = el.checked;
        else if (type === 'number') s[key] = Number(el.value) || defaultSettings[key];
        else s[key] = el.value;
        saveSettings();
        after?.();
    });
}

let connTesting = false;

/** 선택한 프로필(또는 메인 API)로 아주 짧은 요청을 보내 응답 여부와 속도를 확인 */
async function testConnection() {
    if (connTesting) return;
    const out = document.getElementById('sttr_conn_result');
    const btn = document.getElementById('sttr_conn_test');
    const s = settings();
    const profile = getProfiles().find(p => p.id === s.profileId);
    const target = profile
        ? `${profile.name}${profile.model ? ` (${profile.model})` : ''}`
        : '메인 API';

    connTesting = true;
    btn?.classList.add('disabled');
    if (out) {
        out.className = 'sttr-conn-result';
        out.textContent = `${target}에 연결 중…`;
    }

    const started = performance.now();
    try {
        const reply = cleanOutput(await callModel('', 'Reply with exactly one word: OK'));
        const sec = ((performance.now() - started) / 1000).toFixed(1);
        if (out) {
            out.classList.add('sttr-ok');
            out.textContent = reply
                ? `연결 성공: ${target}, ${sec}초, 응답 "${reply.slice(0, 40)}"`
                : `연결은 됐지만 응답 내용이 비어 있어요 (${sec}초). 추론 모델이라면 최대 응답 토큰을 늘려 보세요.`;
        }
    } catch (e) {
        if (out) {
            out.classList.add('sttr-fail');
            out.textContent = `연결 실패: ${errMsg(e)}`;
        }
    } finally {
        connTesting = false;
        btn?.classList.remove('disabled');
    }
}

async function initSettingsUI() {
    const { renderExtensionTemplateAsync } = ctx();
    const html = await renderExtensionTemplateAsync(EXT_FOLDER, 'settings');
    $('#extensions_settings2').append(html);

    refreshProfileSelect();
    bind('sttr_enabled', 'enabled', { type: 'checkbox', after: applyBodyClasses });
    bind('sttr_profile', 'profileId');
    bind('sttr_language', 'language');
    bind('sttr_max_tokens', 'maxTokens', { type: 'number' });
    bind('sttr_system_prompt', 'systemPrompt');
    bind('sttr_prompt', 'prompt');
    bind('sttr_selection_enabled', 'selectionEnabled', { type: 'checkbox', after: applyBodyClasses });
    bind('sttr_selection_chat_only', 'selectionOnlyInChat', { type: 'checkbox' });
    bind('sttr_tags', 'tagTargets', { after: updateAllButtons });
    bind('sttr_show_button', 'showMessageButton', { type: 'checkbox', after: applyBodyClasses });
    bind('sttr_show_wand', 'showWandItem', { type: 'checkbox', after: applyWandVisibility });
    bind('sttr_auto_mode', 'autoMode');
    bind('sttr_dock_enabled', 'dockEnabled', { type: 'checkbox', after: applyBodyClasses });
    bind('sttr_save_translations', 'saveTranslations', { type: 'checkbox', after: () => { memCache.clear(); updateAllButtons(); } });
    bind('sttr_dock_translate', 'dockTranslate', { type: 'checkbox', after: applyBodyClasses });
    bind('sttr_dock_nav', 'dockNav', { type: 'checkbox', after: applyBodyClasses });

    document.getElementById('sttr_dock_diag')?.addEventListener('click', showDiagnostics);

    document.getElementById('sttr_dock_reset')?.addEventListener('click', () => {
        settings().dockPos = null;
        saveSettings();
        applyDockPos();
        toastr.info('플로팅 버튼을 기본 위치로 옮겼어요.');
    });

    document.getElementById('sttr_reset_prompts')?.addEventListener('click', () => {
        const s = settings();
        s.systemPrompt = DEFAULT_SYSTEM_PROMPT;
        s.prompt = DEFAULT_PROMPT;
        $('#sttr_system_prompt').val(s.systemPrompt);
        $('#sttr_prompt').val(s.prompt);
        saveSettings();
        toastr.info('기본 프롬프트로 되돌렸어요.');
    });

    document.getElementById('sttr_conn_test')?.addEventListener('click', testConnection);
    document.getElementById('sttr_profile')?.addEventListener('change', () => {
        const out = document.getElementById('sttr_conn_result');
        if (out) {
            out.textContent = '';
            out.className = 'sttr-conn-result';
        }
    });

    document.getElementById('sttr_test')?.addEventListener('click', async () => {
        const sample = 'The tavern door creaked open, and a cold wind swept across the room.';
        toastr.info(`${profileLabel()}(으)로 테스트 번역 중…`);
        try {
            const out = await translateText(sample, { useCache: false });
            toastr.success(out, '번역 테스트 성공', { timeOut: 8000 });
        } catch (e) {
            toastr.error(errMsg(e), '번역 테스트 실패', { timeOut: 10000 });
        }
    });

    document.getElementById('sttr_clear')?.addEventListener('click', () => {
        let count = 0;
        (ctx().chat ?? []).forEach(m => {
            if (m?.extra?.[MODULE]) {
                delete m.extra[MODULE];
                count++;
            }
        });
        memCache.clear();
        hidePopup();
        updateAllButtons();
        if (count) saveChatSoon();
        toastr.info(`저장된 번역 ${count}건을 지웠어요.`);
    });

    applyBodyClasses();
}

/* ------------------------------------------------------------------ */
/* 슬래시 커맨드                                                         */
/* ------------------------------------------------------------------ */

function registerSlashCommands() {
    const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = ctx();
    if (!SlashCommandParser?.addCommandObject || !SlashCommand || !SlashCommandArgument) return;

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'sttr',
        callback: async (_args, value) => {
            try {
                return await translateText(String(value ?? ''));
            } catch (e) {
                toastr.error(errMsg(e), '번역 실패');
                return '';
            }
        },
        returns: '번역된 텍스트',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: '번역할 텍스트',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
        ],
        helpString: '번역기 설정으로 텍스트를 번역해 결과를 반환합니다. 예: <code>/sttr Hello | /echo</code>',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'sttr-debug',
        callback: async () => {
            showDiagnostics();
            return dockDiagnostics();
        },
        returns: '진단 결과',
        helpString: '플로팅 버튼이 보이지 않을 때 원인을 확인합니다.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'sttr-tags',
        callback: async (_args, value) => {
            const c = ctx();
            const raw = String(value ?? '').trim();
            const mesId = raw === '' ? (c.chat?.length ?? 0) - 1 : Number(raw);
            if (Number.isNaN(mesId) || !c.chat?.[mesId]) {
                toastr.warning('메시지 번호가 올바르지 않습니다.');
                return '';
            }
            await openTagPopup(mesId, autoAnchor());
            const store = getStore(mesId);
            return extractTargets(mesId)
                .map(it => store?.cache?.[cacheKey(it.source)])
                .filter(Boolean)
                .join('\n\n');
        },
        returns: '태그 번역 결과',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: '메시지 번호 (생략하면 마지막 메시지)',
                typeList: [ARGUMENT_TYPE.NUMBER],
                isRequired: false,
            }),
        ],
        helpString: '메시지에서 대상 태그(예: &lt;choices&gt;) 내용을 번역해 팝업으로 보여주고 결과를 반환합니다.',
    }));
}

/* ------------------------------------------------------------------ */
/* 초기화                                                               */
/* ------------------------------------------------------------------ */

/** 같은 확장이 다른 폴더에서 한 번 더 로드됐는지 (예전 버전 폴더가 남아 있는 경우 등) */
function countDuplicates() {
    return {
        panels: document.querySelectorAll('#sttr_settings').length,
        docks: document.querySelectorAll('.sttr-dock').length,
        fabs: document.querySelectorAll('#sttr_fab').length,
    };
}

function warnDuplicate() {
    toastr.warning(
        `선택지 번역기가 두 번 로드되어 있어요. 예전에 직접 넣은 확장 폴더가 남아 있는지 확인하고 지워 주세요. 겹친 플로팅 버튼 때문에 버벅일 수 있어요. (지금 폴더: ${EXT_FOLDER})`,
        '선택지 번역기',
        { timeOut: 15000, extendedTimeOut: 5000 },
    );
}

jQuery(async () => {
    // 다른 사본이 이미 화면을 만들어 놓았으면 이 사본은 실행하지 않음
    if (window.__choiceTranslatorLoaded || document.getElementById('sttr_fab')) {
        console.warn(LOG, '이미 로드된 사본이 있어 이 사본은 실행하지 않습니다:', EXT_FOLDER, window.__choiceTranslatorLoaded);
        warnDuplicate();
        return;
    }
    window.__choiceTranslatorLoaded = EXT_FOLDER;

    settings();
    try {
        await initSettingsUI();
    } catch (e) {
        console.error(LOG, '설정 UI를 불러오지 못했습니다', e);
    }

    createFloatingUI();
    createDock();
    addWandMenuItems();
    updateAllButtons();
    document.addEventListener('click', onMessageButtonClick, true);
    registerSlashCommands();

    const { eventSource, event_types } = ctx();
    const on = (name, fn) => {
        const ev = event_types[name];
        if (ev) eventSource.on(ev, fn);
    };
    const later = (fn, ms = 0) => (...args) => { setTimeout(() => fn(...args), ms); };

    on('CHARACTER_MESSAGE_RENDERED', id => onCharacterMessageRendered(Number(id)));
    on('USER_MESSAGE_RENDERED', later(id => updateButton(Number(id))));
    on('MESSAGE_UPDATED', later(id => updateButton(Number(id))));
    on('MESSAGE_EDITED', later(id => updateButton(Number(id))));
    on('MESSAGE_SWIPED', later(id => updateButton(Number(id)), 50));
    on('MORE_MESSAGES_LOADED', later(updateAllButtons));
    on('MESSAGE_SENT', () => { if (popupState?.kind === 'tag') hidePopup(); });
    on('CHAT_CHANGED', () => {
        hideFab();
        hidePopup();
        navLast = { top: null, time: 0 };
        setTimeout(() => {
            updateAllButtons();
            if (dock && !dock.isConnected) mountDock();
            applyDockPos();
            scheduleDockUpdate();
        }, 100);
    });
    for (const name of ['CONNECTION_PROFILE_CREATED', 'CONNECTION_PROFILE_DELETED', 'CONNECTION_PROFILE_UPDATED', 'CONNECTION_PROFILE_LOADED']) {
        on(name, later(refreshProfileSelect));
    }

    console.log(LOG, `로드 완료 (${EXT_FOLDER})`);

    // 이 사본보다 나중에 로드된 예전 버전(중복 방지 장치가 없는)도 잡아냄
    setTimeout(() => {
        const d = countDuplicates();
        if (d.panels > 1 || d.docks > 1 || d.fabs > 1) warnDuplicate();
    }, 4000);
});
