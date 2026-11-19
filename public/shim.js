/*
 * 手書きノート 公開版 — サーバー接続部品（shim）
 * アプリ本体が使う window.claude.use(...) 相当の機能を、Cloudflare Workers 上の
 * 自前サーバー（/api/...）で提供します。サーバーが見つからない環境（claude.ai の
 * アーティファクト表示など）では何もせず、アプリは従来どおり動きます。
 */
(() => {
  'use strict';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const err = (code, message, extra) => Object.assign(new Error(message || code), { code }, extra || {});

  let cfg = null;
  const api = {
    me: null,
    ready: null,
    use: null,
    logout: null,
    changePassword: null,
  };
  window.__inknote = api;

  /* ---------- HTTP ---------- */
  async function req(path, { method = 'POST', body, raw, headers, signal, relogin = true } = {}) {
    let r;
    for (let attempt = 0; ; attempt++) {
      try {
        r = await fetch(path, {
          method, signal, credentials: 'same-origin', cache: 'no-store',
          headers: raw ? headers : { 'content-type': 'application/json', ...(headers || {}) },
          body: raw ? raw : body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        if (attempt < 1 && !raw && !/\/api\/ai$/.test(path)) { await sleep(600); continue; }   // AI 呼び出しは二重に実行しないよう再試行しない
        throw err('unavailable', `サーバーに接続できませんでした（${(e && e.message) || 'ネットワークエラー'}）。通信状態を確認して、もう一度お試しください`);
      }
      if (r.status === 401 && relogin && api.me) {
        // セッション切れ → ログインし直してから1回だけやり直す
        await showLogin('セッションの有効期限が切れました。もう一度ログインしてください。');
        relogin = false; continue;
      }
      break;
    }
    let data = null;
    const ct = r.headers.get('content-type') || '';
    if (ct.includes('application/json')) { try { data = await r.json(); } catch {} }
    if (r.ok && data && data.error && typeof data.error === 'object') {
      // AI の応答は途中から返すため、エラーは本文で届く
      throw err(data.error.code || 'error', data.error.message || 'エラーが発生しました', { status: data.error.status });
    }
    if (!r.ok) {
      const code = (data && data.code) || (r.status === 429 ? 'rate_limited' : r.status === 401 ? 'unauthenticated' : r.status >= 500 ? 'unavailable' : 'error');
      throw err(code, (data && data.message) || `サーバーエラー（${r.status}）`, { status: r.status });
    }
    return data;
  }

  /* ---------- login UI ---------- */
  const CSS = `
  #ink-login{position:fixed;inset:0;z-index:1000;background:rgba(244,241,234,.97);display:flex;align-items:center;justify-content:center;font-family:"Zen Kaku Gothic New",system-ui,sans-serif;color:#222}
  #ink-login .card{width:min(360px,90vw);background:#fff;border:1px solid #d8d2c4;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.08);padding:22px 22px 18px}
  #ink-login h1{font-size:20px;margin:0 0 4px}
  #ink-login .sub{font-size:12px;color:#777;margin:0 0 14px}
  #ink-login .tabs{display:flex;gap:6px;margin-bottom:12px}
  #ink-login .tabs button{flex:1;padding:8px;border:1px solid #d8d2c4;background:#faf8f3;border-radius:8px;font:inherit;font-size:14px;cursor:pointer;color:#444}
  #ink-login .tabs button.on{background:#2f5fa8;border-color:#2f5fa8;color:#fff}
  #ink-login label{display:block;font-size:12px;color:#555;margin:10px 0 4px}
  #ink-login input{width:100%;box-sizing:border-box;padding:10px;border:1px solid #cfc8b8;border-radius:8px;font:inherit;font-size:16px;color:#111;background:#fff}
  #ink-login .go{width:100%;margin-top:16px;padding:11px;border:0;border-radius:9px;background:#2f5fa8;color:#fff;font:inherit;font-size:15px;cursor:pointer}
  #ink-login .go:disabled{opacity:.6}
  #ink-login .msg{min-height:18px;font-size:12px;color:#c0392b;margin-top:10px;white-space:pre-wrap}
  #ink-login .note{font-size:11px;color:#888;margin-top:8px}`;

  let loginWaiters = [];
  function showLogin(message) {
    return new Promise(resolve => {
      loginWaiters.push(resolve);
      if (document.getElementById('ink-login')) return;
      const mount = () => {
        if (!document.getElementById('ink-login-css')) {
          const st = document.createElement('style'); st.id = 'ink-login-css'; st.textContent = CSS; document.head.append(st);
        }
        const reg = cfg && cfg.registration !== 'closed';
        const wrap = document.createElement('div'); wrap.id = 'ink-login';
        wrap.innerHTML = `<form class="card" autocomplete="on">
          <h1>手書きノート</h1>
          <p class="sub">${cfg && cfg.name ? esc(cfg.name) : 'ログインして使います'}</p>
          ${reg ? '<div class="tabs"><button type="button" data-t="login" class="on">ログイン</button><button type="button" data-t="reg">新規登録</button></div>' : ''}
          <label>ユーザー名</label><input name="username" autocomplete="username" autocapitalize="off" autocorrect="off" spellcheck="false" required maxlength="32">
          <label>パスワード</label><input name="password" type="password" autocomplete="current-password" required minlength="8" maxlength="200">
          <div class="regonly" hidden>
            <label>パスワード（確認）</label><input name="password2" type="password" autocomplete="new-password" maxlength="200">
            ${cfg && cfg.registration === 'invite' ? '<label>招待コード</label><input name="invite" autocapitalize="off" autocorrect="off" spellcheck="false" maxlength="200">' : ''}
            ${cfg && cfg.registration === 'first' ? '<p class="note">最初の登録者になります。登録後はこのサーバーに新しく登録できなくなります（招待コードを設定すると追加できます）。</p>' : ''}
          </div>
          <button class="go" type="submit">ログイン</button>
          <div class="msg"></div>
          <p class="note">ユーザー名は半角英数字と _ - . （3〜32文字）。パスワードは8文字以上。</p>
        </form>`;
        document.body.append(wrap);
        const f = wrap.querySelector('form'), msg = wrap.querySelector('.msg'), go = wrap.querySelector('.go');
        let mode = (cfg && cfg.registration === 'first') ? 'reg' : 'login';
        const setMode = m => {
          mode = m;
          wrap.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.t === m));
          wrap.querySelector('.regonly').hidden = m !== 'reg';
          f.password.autocomplete = m === 'reg' ? 'new-password' : 'current-password';
          go.textContent = m === 'reg' ? '登録してはじめる' : 'ログイン';
          msg.textContent = '';
        };
        wrap.querySelectorAll('.tabs button').forEach(b => b.onclick = () => setMode(b.dataset.t));
        setMode(mode);
        if (message) msg.textContent = message;
        f.onsubmit = async e => {
          e.preventDefault();
          msg.textContent = '';
          const username = f.username.value.trim(), password = f.password.value;
          if (mode === 'reg' && password !== f.password2.value) { msg.textContent = 'パスワード（確認）が一致しません'; return; }
          go.disabled = true;
          try {
            const body = { username, password };
            if (mode === 'reg' && f.invite) body.invite = f.invite.value.trim();
            const me = await req(mode === 'reg' ? '/api/register' : '/api/login', { body, relogin: false });
            const prev = api.me;
            if (prev && prev.id !== me.id) { location.reload(); return; } // 別のユーザーに切り替えた
            api.me = me;
            wrap.remove();
            const ws = loginWaiters; loginWaiters = []; ws.forEach(r => r(me));
          } catch (e2) {
            msg.textContent = e2.message || 'ログインできませんでした';
          } finally { go.disabled = false; }
        };
        setTimeout(() => f.username.focus(), 50);
      };
      if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount, { once: true });
    });
  }
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  api.logout = async () => {
    try { await req('/api/logout', { relogin: false }); } catch {}
    location.reload();
  };
  api.changePassword = async () => {
    const old = prompt('現在のパスワード'); if (old == null) return;
    const nw = prompt('新しいパスワード（8文字以上）'); if (nw == null) return;
    if (nw.length < 8) { alert('8文字以上にしてください'); return; }
    if (prompt('新しいパスワード（確認）') !== nw) { alert('確認用のパスワードが一致しません'); return; }
    try { await req('/api/password', { body: { old, password: nw } }); alert('パスワードを変更しました。ほかの端末ではログアウトされます。'); }
    catch (e) { alert(e.message || '変更できませんでした'); }
  };

  /* ---------- AI の選択（この端末に保存） ---------- */
  const AI_KEY = 'inknote:ai';
  function aiPrefs() { try { return JSON.parse(localStorage.getItem(AI_KEY) || '{}') || {}; } catch { return {}; } }
  function saveAiPrefs(p) { try { localStorage.setItem(AI_KEY, JSON.stringify(p)); } catch {} }
  api.aiLabel = () => {
    if (!cfg || !cfg.ai) return 'AI：未設定';
    const st = aiPrefs(), id = st.provider || cfg.defaultProvider;
    const P = (cfg.providers || []).find(x => x.id === id);
    if (!P) return 'AI：未選択';
    const model = st.provider === id && st.model ? st.model : P.model;
    return `AI：${P.label}${model ? `（${model}）` : ''}${st.provider === id && (st.keys || {})[id] ? '・自分のキー' : ''}`;
  };
  const AI_CSS = `
  #ink-ai{position:fixed;inset:0;z-index:1000;background:rgba(30,30,30,.35);display:flex;align-items:center;justify-content:center;font-family:"Zen Kaku Gothic New",system-ui,sans-serif;color:#222}
  #ink-ai .card{width:min(520px,94vw);max-height:90vh;overflow:auto;background:#fff;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.18);padding:18px 20px}
  #ink-ai h2{font-size:18px;margin:0 0 10px}
  #ink-ai .pv{display:flex;flex-direction:column;gap:6px}
  #ink-ai .pv label{display:flex;gap:8px;align-items:flex-start;border:1.5px solid #e1dbcd;border-radius:10px;padding:8px 10px;cursor:pointer}
  #ink-ai .pv label.on{border-color:#2f5fa8;background:#f4f8ff}
  #ink-ai .st{font-size:11.5px;color:#777}
  #ink-ai .st.ok{color:#2e7d32}
  #ink-ai .f{margin-top:10px}
  #ink-ai .f>span{display:block;font-size:12px;color:#555;margin-bottom:3px}
  #ink-ai input[type=text],#ink-ai input[type=password]{width:100%;box-sizing:border-box;padding:9px;border:1px solid #cfc8b8;border-radius:8px;font:inherit;font-size:15px;color:#111;background:#fff}
  #ink-ai .row{display:flex;gap:8px;align-items:center}
  #ink-ai .note{font-size:11.5px;color:#888;margin-top:4px;line-height:1.5}
  #ink-ai .btns{display:flex;justify-content:flex-end;gap:8px;margin-top:16px;flex-wrap:wrap}
  #ink-ai button{padding:8px 14px;border:1px solid #cfc8b8;border-radius:8px;background:#fff;font:inherit;font-size:14px;cursor:pointer;color:#222}
  #ink-ai button.pri{background:#2f5fa8;border-color:#2f5fa8;color:#fff}
  #ink-ai .msg{font-size:12.5px;margin-top:8px;min-height:1em;white-space:pre-wrap}`;
  api.aiSettings = () => new Promise(resolve => {
    if (!cfg) return resolve(false);
    if (!document.getElementById('ink-ai-css')) { const st = document.createElement('style'); st.id = 'ink-ai-css'; st.textContent = AI_CSS; document.head.append(st); }
    const prefs = aiPrefs(); prefs.keys = prefs.keys || {};
    let pid = prefs.provider || cfg.defaultProvider || ((cfg.providers || [])[0] || {}).id;
    const wrap = document.createElement('div'); wrap.id = 'ink-ai';
    const card = document.createElement('div'); card.className = 'card'; wrap.append(card);
    const el = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const k in attrs) { if (k === 'text') e.textContent = attrs[k]; else if (k.startsWith('on')) e[k] = attrs[k]; else e.setAttribute(k, attrs[k]); } e.append(...kids.filter(Boolean)); return e; };
    const close = ok => { wrap.remove(); resolve(ok); };
    const draw = () => {
      card.textContent = '';
      const P = (cfg.providers || []).find(x => x.id === pid);
      card.append(el('h2', { text: 'AIの設定' }),
        el('div', { class: 'note', text: '要約・図表・問題作成・添削・文字認識などに使うAIを選びます。設定はこの端末（このブラウザ）に保存されます。' }));
      const pv = el('div', { class: 'pv' });
      for (const x of cfg.providers || []) {
        const usable = x.server || (cfg.allowUserKeys && !x.noKey);
        const own = !x.noKey && !!prefs.keys[x.id];
        const r = el('input', { type: 'radio', name: 'pv' }); r.checked = x.id === pid; r.disabled = !usable;
        r.onchange = () => { pid = x.id; draw(); };
        pv.append(el('label', { class: x.id === pid ? 'on' : '' }, r, el('div', null, el('div', { text: x.label }),
          el('div', { class: 'st' + (x.server || own ? ' ok' : ''), text: x.noKey ? (x.server ? `キー不要で利用可（Cloudflare の無料枠内・1日${cfg.dailyLimit}回まで）` : '利用できません（サーバーで有効になっていません）') : own ? '自分のAPIキーを使用' : x.server ? `サーバーのキーで利用可（1日${cfg.dailyLimit}回まで）` : cfg.allowUserKeys ? '自分のAPIキーが必要' : '利用できません' }))));
      }
      card.append(pv);
      if (!P) { card.append(el('div', { class: 'btns' }, el('button', { text: '閉じる', onclick: () => close(false) }))); return; }
      const same = prefs.provider === pid;
      const mIn = el('input', { type: 'text', list: 'ink-ai-models', placeholder: P.model || 'モデル名', autocapitalize: 'off', spellcheck: 'false' }); mIn.value = same ? (prefs.model || '') : '';
      const cIn = el('input', { type: 'text', list: 'ink-ai-models', placeholder: same && prefs.model ? prefs.model : (P.complex || P.model || 'モデル名'), autocapitalize: 'off', spellcheck: 'false' }); cIn.value = same ? (prefs.modelComplex || '') : '';
      const kIn = el('input', { type: 'password', placeholder: P.server ? '（空欄ならサーバーのキーを使用）' : 'APIキー', autocomplete: 'off' }); kIn.value = prefs.keys[pid] || '';
      const bIn = el('input', { type: 'text', placeholder: 'https://openrouter.ai/api/v1', autocapitalize: 'off', spellcheck: 'false' }); bIn.value = prefs.baseUrl || '';
      const dl = el('datalist', { id: 'ink-ai-models' });
      const msg = el('div', { class: 'msg' });
      const cur = () => ({ provider: pid, model: mIn.value.trim(), modelComplex: cIn.value.trim(), baseUrl: bIn.value.trim(), key: kIn.value.trim() });
      const hdr = c => c.key ? { 'x-user-ai-key': c.key } : undefined;
      const loadModels = async () => {
        const c = cur(); msg.style.color = '#555'; msg.textContent = 'モデルの一覧を取得中…';
        try {
          const r = await req('/api/ai/models', { body: { provider: c.provider, baseUrl: c.baseUrl || undefined }, headers: hdr(c) });
          dl.textContent = ''; for (const m of r.models || []) dl.append(el('option', { value: m }));
          msg.textContent = `${(r.models || []).length} 個のモデルが見つかりました。入力欄をタップすると候補が出ます。`;
        } catch (e) { msg.style.color = '#c0392b'; msg.textContent = e.message || '取得できませんでした'; }
      };
      const test = async () => {
        const c = cur(); msg.style.color = '#555'; msg.textContent = '接続テスト中…';
        try {
          const r = await req('/api/ai', { body: { prompt: '「OK」とだけ返してください。', provider: c.provider, model: c.model || undefined, modelComplex: c.modelComplex || undefined, baseUrl: c.baseUrl || undefined }, headers: hdr(c) });
          msg.style.color = '#2e7d32'; msg.textContent = `接続できました（${r.model}）：${String(r.text || '').slice(0, 40)}`;
        } catch (e) { msg.style.color = '#c0392b'; msg.textContent = e.message || '接続できませんでした'; }
      };
      card.append(dl,
        P.id === 'openai-compatible' ? el('label', { class: 'f' }, el('span', { text: 'サービスの URL' + (P.needsBase ? '' : '（空欄ならサーバーの設定）') }), bIn) : null,
        cfg.allowUserKeys && !P.noKey ? el('label', { class: 'f' }, el('span', { text: '自分のAPIキー' + (P.server ? '（任意）' : '') }), kIn,
          el('div', { class: 'note', text: 'キーはこの端末のブラウザにだけ保存し、AIを呼ぶときにサーバーを通して各サービスへ送ります（サーバーには保存しません）。自分のキーを使うと、1日の回数制限はかかりません。' })) : null,
        el('label', { class: 'f' }, el('span', { text: 'モデル（ふだんの処理）' }), el('div', { class: 'row' }, mIn, el('button', { text: '一覧', onclick: e => { e.preventDefault(); loadModels(); } }))),
        el('label', { class: 'f' }, el('span', { text: 'モデル（重い処理：画像の解析・本番テスト・添削など）' }), cIn),
        el('div', { class: 'note', text: (P.model ? `空欄なら標準のモデル（${P.model}${P.complex && P.complex !== P.model ? ' / ' + P.complex : ''}）を使います。` : 'モデルを選んでください（「一覧」から選べます）。') + '画像を扱う機能（写真の解析・手書きの読み取りなど）には、画像に対応したモデルを選んでください。' + (P.id === 'openrouter' ? '名前が「:free」で終わるモデルは無料です（回数制限あり）。' : '') + (P.noKey ? '画像に対応するのは llama-4-scout と mistral-small です。' : '') }),
        msg,
        el('div', { class: 'btns' },
          el('button', { text: '接続テスト', onclick: test }),
          el('button', { text: 'キャンセル', onclick: () => close(false) }),
          el('button', { class: 'pri', text: '保存', onclick: () => {
            const c = cur();
            const keys = { ...prefs.keys }; if (c.key) keys[pid] = c.key; else delete keys[pid];
            saveAiPrefs({ provider: pid, model: c.model, modelComplex: c.modelComplex, baseUrl: c.baseUrl, keys });
            close(true);
          } })));
    };
    draw();
    wrap.addEventListener('pointerdown', e => { if (e.target === wrap) close(false); });
    document.body.append(wrap);
  });

  /* ---------- capabilities ---------- */
  function snapOf(id, data) {
    const json = data == null ? null : JSON.stringify(data);
    return { id, exists: data != null, data: () => (json == null ? undefined : JSON.parse(json)) };
  }
  function querySnap(rows) {
    const docs = rows.map(r => snapOf(r.id, r.data));
    return { docs, size: docs.length, empty: !docs.length, forEach: fn => docs.forEach(fn) };
  }
  function makeQuery(filters) {
    return {
      where(field, op, value) { return makeQuery([...filters, [field, op, value]]); },
      async get() { const r = await req('/api/db', { body: { op: 'query', where: filters } }); return querySnap(r.docs || []); },
    };
  }
  const db = {
    collection(_path) {
      // サーバー側でログイン中のユーザー専用の領域に固定されるため、パスは使わない
      const q = makeQuery([]);
      return {
        ...q,
        doc(id) {
          id = String(id);
          return {
            id,
            async get() { const r = await req('/api/db', { body: { op: 'get', id } }); return snapOf(id, r.data); },
            async set(data) { await req('/api/db', { body: { op: 'set', id, data } }); },
            async delete() { await req('/api/db', { body: { op: 'delete', id } }); },
          };
        },
      };
    },
  };

  const user = { id: async () => api.me && api.me.id, name: async () => api.me && api.me.name };

  function blobToB64(b) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => { const s = String(fr.result); res({ type: b.type || 'image/jpeg', data: s.slice(s.indexOf(',') + 1) }); };
      fr.onerror = () => rej(fr.error); fr.readAsDataURL(b);
    });
  }
  // AI に送る画像は長辺 1600px・JPEG に縮める（送信量と処理時間を減らす。文字の読み取りにはこれで十分）
  async function shrinkForAI(b) {
    try {
      if (!/^image\//.test(b.type) || b.type === 'image/svg+xml' || typeof createImageBitmap !== 'function') return b;
      const bmp = await createImageBitmap(b);
      const MAX = 1600, sc = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
      if (sc >= 1 && b.size < 900 * 1024) { bmp.close && bmp.close(); return b; }
      const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(bmp.width * sc)); c.height = Math.max(1, Math.round(bmp.height * sc));
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0, c.width, c.height);
      bmp.close && bmp.close();
      const out = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.85));
      return out && out.size < b.size ? out : b;
    } catch { return b; }
  }
  async function imagePayload(images) {
    const out = [];
    for (const im of images || []) {
      if (im instanceof Blob) out.push(await blobToB64(await shrinkForAI(im)));
      else if (typeof im === 'string' && im.startsWith('data:')) out.push({ type: im.slice(5, im.indexOf(';')), data: im.slice(im.indexOf(',') + 1) });
      else if (im && im.data) out.push(im);
    }
    return out;
  }
  function parseJSON(text) {
    let t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const a = t.search(/[[{]/), b = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
    if (a >= 0 && b > a) t = t.slice(a, b + 1);
    return JSON.parse(t);
  }
  async function ask(prompt, opts = {}) {
    const images = await imagePayload(opts.images);
    const st = aiPrefs(), key = st.provider ? (st.keys || {})[st.provider] : '';
    const r = await req('/api/ai', {
      body: { prompt: String(prompt), images, tier: opts.modelTier || 'default', json: !!opts.json, provider: st.provider || undefined, model: st.model || undefined, modelComplex: st.modelComplex || undefined, baseUrl: st.provider === 'openai-compatible' ? st.baseUrl : undefined },
      headers: key ? { 'x-user-ai-key': key } : undefined, signal: opts.signal });
    const text = r.text || '';
    if (typeof opts.onText === 'function') { try { opts.onText({ text }); } catch {} }
    return { text };
  }
  function makeSample() {
    const sample = (prompt, opts) => ask(prompt, opts);
    sample.json = async (prompt, opts = {}) => {
      const r = await ask(prompt + '\n\n（出力は JSON のみ。説明やコードフェンスは付けない）', { ...opts, json: true });
      try { return parseJSON(r.text); } catch { throw err('bad_json', 'AIの出力を解釈できませんでした'); }
    };
    sample.limits = async () => ({ images: !!cfg.aiImages });
    return sample;
  }

  const assets = {
    async upload(blob) {
      const r = await req('/api/assets', { raw: blob, headers: { 'content-type': blob.type || 'application/octet-stream' } });
      return { id: r.id, url: '/_blob/' + r.id };
    },
  };

  const downloads = {
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = filename || 'download'; a.rel = 'noopener';
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      return true;
    },
  };

  const SCHEMAS = {
    web_fetch: { type: 'object', required: ['urls'], properties: { urls: { type: 'array' }, full_content: { type: 'boolean' }, objective: { type: 'string' } } },
    web_search: { type: 'object', required: ['objective'], properties: { objective: { type: 'string' }, search_queries: { type: 'array' } } },
  };
  function makeMcp() {
    return {
      canSearch: !!cfg.search,
      async describeTool(_server, tool) { return { inputSchema: SCHEMAS[tool] || null }; },
      async callTool(_server, tool, input, opts = {}) {
        if (tool === 'web_fetch') return { payload: await req('/api/web/fetch', { body: input, signal: opts.signal }) };
        if (tool === 'web_search') {
          if (!cfg.search) throw err('server_unavailable', 'Web検索はこのサーバーで設定されていません');
          return { payload: await req('/api/web/search', { body: input, signal: opts.signal }) };
        }
        throw err('not_in_manifest', '未対応のツールです');
      },
    };
  }

  api.use = async name => {
    switch (name) {
      case 'db': return db;
      case 'user': return user;
      case 'sample': return cfg.ai ? makeSample() : null;
      case 'assets': return assets;
      case 'downloads': return downloads;
      case 'mcp': return makeMcp();
      default: return null;
    }
  };

  /* ---------- boot ---------- */
  api.ready = (async () => {
    try {
      const r = await fetch('/api/config', { credentials: 'same-origin', cache: 'no-store' });
      if (!r.ok || r.headers.get('x-inknote') !== '1') return false;
      cfg = await r.json();
    } catch { return false; }
    try { api.me = await req('/api/me', { method: 'GET', relogin: false }); }
    catch (e) {
      if (e.code !== 'unauthenticated') {
        // 一時的な接続エラー：ログイン画面を出してやり直してもらう
        await showLogin('サーバーに接続できませんでした。もう一度お試しください。');
        return true;
      }
      await showLogin();
    }
    return true;
  })();
})();
