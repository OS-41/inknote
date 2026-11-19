/*
 * 手書きノート 公開版 — Cloudflare Worker
 *
 *  /api/config            公開設定（ログイン不要）
 *  /api/register|login|logout|me|password   アカウント
 *  /api/db                ノートの保存・読み込み（ユーザーごとに分離）
 *  /api/assets            画像のアップロード  → /_blob/<id> で取得
 *  /api/ai                AI 呼び出し（API キーはサーバー側のシークレットにだけ置く）
 *  /api/web/fetch|search  URL本文の取得・Web検索
 *
 * それ以外のパス（index.html など）は静的アセットとして配信されます。
 */
import { Buffer } from 'node:buffer';

const SESSION_DAYS = 60;
const COOKIE = 'inknote_sid';
const MAX_DOC = 1_000_000;           // 1ドキュメントの上限（アプリ側は約190KBずつに分割して保存）
const MAX_BLOB = 15 * 1024 * 1024;   // 画像1枚の上限
const CHUNK = 1_400_000;             // D1 に画像を置くときの1行あたりのバイト数（D1 の行上限は 2MB）

/* ================= helpers ================= */
const enc = new TextEncoder();
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-inknote': '1', ...headers },
  });
}
const fail = (status, code, message) => json({ code, message }, status);
class HttpError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const bad = (msg, code = 'bad_request') => { throw new HttpError(400, code, msg); };

function hex(buf) { return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join(''); }
function randomId(bytes = 16) { const a = new Uint8Array(bytes); crypto.getRandomValues(a); return hex(a); }
async function sha256(s) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(s))); }
function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0;
}
const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : d; };
const today = () => new Date().toISOString().slice(0, 10);

async function readJSON(req, limit = 30 * 1024 * 1024) {
  const len = +(req.headers.get('content-length') || 0);
  if (len > limit) throw new HttpError(413, 'too_large', 'データが大きすぎます');
  try { return await req.json(); } catch { bad('JSON を読み取れません'); }
}
function getCookie(req, name) {
  const c = req.headers.get('cookie') || '';
  for (const part of c.split(/;\s*/)) { const i = part.indexOf('='); if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1)); }
  return null;
}
function sessionCookie(url, token, maxAge) {
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE}=${token ? encodeURIComponent(token) : ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

/* ================= passwords ================= */
// Workers の無料プランは CPU 時間が短い（10ms）ため、反復回数は環境変数で調整できるようにしている。
// 反復回数はユーザーごとに保存するので、後から増やしても既存ユーザーはそのままログインでき、次回ログイン時に更新される。
async function hashPassword(password, saltHex, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const salt = new Uint8Array(saltHex.match(/../g).map(h => parseInt(h, 16)));
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return hex(bits);
}
const pbkdfIter = env => Math.min(100000, int(env.PBKDF2_ITERATIONS, 20000));

/* ================= auth ================= */
async function currentUser(req, env) {
  const tok = getCookie(req, COOKIE);
  if (!tok || tok.length > 200) return null;
  const row = await env.DB.prepare(
    'SELECT u.id, u.name, s.expires FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?'
  ).bind(await sha256(tok)).first();
  if (!row || row.expires < Date.now()) return null;
  return { id: row.id, name: row.name };
}
async function newSession(env, url, userId) {
  const tok = randomId(32);
  const expires = Date.now() + SESSION_DAYS * 864e5;
  await env.DB.prepare('INSERT INTO sessions (id, user_id, expires) VALUES (?, ?, ?)').bind(await sha256(tok), userId, expires).run();
  // 期限切れのセッションを掃除（ついでに）
  await env.DB.prepare('DELETE FROM sessions WHERE expires < ?').bind(Date.now()).run();
  return sessionCookie(url, tok, SESSION_DAYS * 86400);
}
function registrationMode(env, userCount) {
  if (env.INVITE_CODE) return 'invite';
  return userCount === 0 ? 'first' : 'closed';
}
const NAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;

async function tooManyFailures(env, key) {
  const since = Date.now() - 15 * 60 * 1000;
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM login_failures WHERE key = ? AND at > ?').bind(key, since).first();
  return (r && r.n) >= 10;
}
async function noteFailure(env, key) {
  await env.DB.prepare('INSERT INTO login_failures (key, at) VALUES (?, ?)').bind(key, Date.now()).run();
  await env.DB.prepare('DELETE FROM login_failures WHERE at < ?').bind(Date.now() - 24 * 3600 * 1000).run();
}

async function register(req, env, url) {
  const { username, password, invite } = await readJSON(req, 10000);
  const name = String(username || '').trim();
  if (!NAME_RE.test(name)) bad('ユーザー名は半角英数字と _ - . の3〜32文字にしてください');
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) bad('パスワードは8文字以上にしてください');
  const cnt = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
  const mode = registrationMode(env, cnt ? cnt.n : 0);
  if (mode === 'closed') throw new HttpError(403, 'closed', 'このサーバーでは新規登録を受け付けていません');
  if (mode === 'invite') {
    const ip = req.headers.get('cf-connecting-ip') || 'unknown';
    if (await tooManyFailures(env, 'invite:' + ip)) throw new HttpError(429, 'rate_limited', '試行回数が多すぎます。しばらく待ってからお試しください');
    if (!timingSafeEqualHex(await sha256(String(invite || '')), await sha256(env.INVITE_CODE))) {
      await noteFailure(env, 'invite:' + ip);
      throw new HttpError(403, 'bad_invite', '招待コードが違います');
    }
  }
  const exists = await env.DB.prepare('SELECT 1 FROM users WHERE name_lc = ?').bind(name.toLowerCase()).first();
  if (exists) throw new HttpError(409, 'name_taken', 'このユーザー名は使われています');
  const id = 'u' + randomId(10), salt = randomId(16), iter = pbkdfIter(env);
  const hash = await hashPassword(password, salt, iter);
  await env.DB.prepare('INSERT INTO users (id, name, name_lc, pw_hash, pw_salt, pw_iter, created) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, name, name.toLowerCase(), hash, salt, iter, Date.now()).run();
  return json({ id, name }, 200, { 'set-cookie': await newSession(env, url, id) });
}

async function login(req, env, url) {
  const { username, password } = await readJSON(req, 10000);
  const name = String(username || '').trim();
  const key = 'login:' + name.toLowerCase();
  if (await tooManyFailures(env, key)) throw new HttpError(429, 'rate_limited', 'ログインの失敗が続いたため、15分ほど待ってからお試しください');
  const u = await env.DB.prepare('SELECT id, name, pw_hash, pw_salt, pw_iter FROM users WHERE name_lc = ?').bind(name.toLowerCase()).first();
  const ok = u && typeof password === 'string' && timingSafeEqualHex(await hashPassword(password, u.pw_salt, u.pw_iter), u.pw_hash);
  if (!ok) { await noteFailure(env, key); throw new HttpError(401, 'bad_login', 'ユーザー名またはパスワードが違います'); }
  const iter = pbkdfIter(env);
  if (u.pw_iter !== iter) {
    const salt = randomId(16);
    await env.DB.prepare('UPDATE users SET pw_hash = ?, pw_salt = ?, pw_iter = ? WHERE id = ?').bind(await hashPassword(password, salt, iter), salt, iter, u.id).run();
  }
  return json({ id: u.id, name: u.name }, 200, { 'set-cookie': await newSession(env, url, u.id) });
}

async function logout(req, env, url) {
  const tok = getCookie(req, COOKIE);
  if (tok) await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(await sha256(tok)).run();
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie(url, '', 0) });
}

async function changePassword(req, env, url, me) {
  const { old, password } = await readJSON(req, 10000);
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) bad('パスワードは8文字以上にしてください');
  const u = await env.DB.prepare('SELECT pw_hash, pw_salt, pw_iter FROM users WHERE id = ?').bind(me.id).first();
  if (!u || typeof old !== 'string' || !timingSafeEqualHex(await hashPassword(old, u.pw_salt, u.pw_iter), u.pw_hash))
    throw new HttpError(403, 'bad_login', '現在のパスワードが違います');
  const salt = randomId(16), iter = pbkdfIter(env);
  await env.DB.prepare('UPDATE users SET pw_hash = ?, pw_salt = ?, pw_iter = ? WHERE id = ?').bind(await hashPassword(password, salt, iter), salt, iter, me.id).run();
  await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(me.id).run();
  return json({ ok: true }, 200, { 'set-cookie': await newSession(env, url, me.id) });
}

/* ================= documents ================= */
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;
function docId(id) {
  if (typeof id !== 'string' || !id || id.length > 300 || /[\u0000-\u001f]/.test(id)) bad('ドキュメントIDが不正です');
  return id;
}
async function dbOp(req, env, me) {
  const body = await readJSON(req, 2 * MAX_DOC);
  const DB = env.DB;
  switch (body.op) {
    case 'get': {
      const r = await DB.prepare('SELECT data FROM docs WHERE owner = ? AND id = ?').bind(me.id, docId(body.id)).first();
      return json({ data: r ? JSON.parse(r.data) : null });
    }
    case 'set': {
      const id = docId(body.id), data = body.data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) bad('保存するデータが不正です');
      const s = JSON.stringify(data);
      if (s.length > MAX_DOC) throw new HttpError(413, 'too_large', 'ドキュメントが大きすぎます');
      const kind = typeof data.kind === 'string' ? data.kind : null, note = typeof data.note === 'string' ? data.note : null;
      await DB.prepare(
        'INSERT INTO docs (owner, id, kind, note, data, updated) VALUES (?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(owner, id) DO UPDATE SET kind = excluded.kind, note = excluded.note, data = excluded.data, updated = excluded.updated'
      ).bind(me.id, id, kind, note, s, Date.now()).run();
      return json({ ok: true });
    }
    case 'delete': {
      await DB.prepare('DELETE FROM docs WHERE owner = ? AND id = ?').bind(me.id, docId(body.id)).run();
      return json({ ok: true });
    }
    case 'query': {
      const where = Array.isArray(body.where) ? body.where : [];
      if (where.length > 5) bad('条件が多すぎます');
      let sql = 'SELECT id, data FROM docs WHERE owner = ?'; const args = [me.id];
      for (const w of where) {
        if (!Array.isArray(w) || w.length !== 3) bad('条件が不正です');
        const [f, op, v] = w;
        if (!FIELD_RE.test(String(f))) bad('項目名が不正です');
        if (op !== '==' && op !== '!=') bad('未対応の比較です');
        if (v !== null && !['string', 'number', 'boolean'].includes(typeof v)) bad('比較する値が不正です');
        const col = f === 'kind' || f === 'note' ? f : `json_extract(data, '$.${f}')`;
        sql += ` AND ${col} ${op === '==' ? '=' : '!='} ?`; args.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
      }
      sql += ' ORDER BY id LIMIT 5000';
      const { results } = await DB.prepare(sql).bind(...args).all();
      return json({ docs: results.map(r => ({ id: r.id, data: JSON.parse(r.data) })) });
    }
    default: bad('未対応の操作です');
  }
}

/* ================= images ================= */
const IMG_TYPES = /^image\/(jpeg|png|gif|webp|heic|heif|avif|svg\+xml)$/;
async function uploadAsset(req, env, me) {
  const type = (req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!IMG_TYPES.test(type)) bad('画像ファイルのみ保存できます');
  const buf = new Uint8Array(await req.arrayBuffer());
  if (!buf.length) bad('空のファイルです');
  if (buf.length > MAX_BLOB) throw new HttpError(413, 'too_large', '画像が大きすぎます');
  const quota = int(env.MAX_STORAGE_MB_PER_USER, 300) * 1024 * 1024;
  const used = await env.DB.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM blobs WHERE owner = ?').bind(me.id).first();
  if ((used ? used.n : 0) + buf.length > quota) throw new HttpError(413, 'quota', '画像の保存容量の上限に達しました');
  const id = 'b' + randomId(16);
  if (env.BLOBS) {
    await env.BLOBS.put(`${me.id}/${id}`, buf, { httpMetadata: { contentType: type } });
  } else {
    // R2 を使わない場合は D1 に分割して保存
    const parts = Math.ceil(buf.length / CHUNK);
    for (let i = 0; i < parts; i++) {
      const b64 = Buffer.from(buf.subarray(i * CHUNK, (i + 1) * CHUNK)).toString('base64');
      await env.DB.prepare('INSERT INTO blob_chunks (id, idx, data) VALUES (?, ?, ?)').bind(id, i, b64).run();
    }
  }
  await env.DB.prepare('INSERT INTO blobs (id, owner, type, size, created) VALUES (?, ?, ?, ?, ?)').bind(id, me.id, type, buf.length, Date.now()).run();
  return json({ id });
}
async function serveBlob(env, me, id) {
  if (!/^b[0-9a-f]{32}$/.test(id)) return new Response('Not found', { status: 404 });
  const meta = await env.DB.prepare('SELECT type, size FROM blobs WHERE id = ? AND owner = ?').bind(id, me.id).first();
  if (!meta) return new Response('Not found', { status: 404 });
  let body;
  if (env.BLOBS) {
    const o = await env.BLOBS.get(`${me.id}/${id}`);
    if (!o) return new Response('Not found', { status: 404 });
    body = o.body;
  } else {
    const { results } = await env.DB.prepare('SELECT data FROM blob_chunks WHERE id = ? ORDER BY idx').bind(id).all();
    body = Buffer.concat(results.map(r => Buffer.from(r.data, 'base64')));
  }
  return new Response(body, {
    headers: {
      'content-type': meta.type, 'cache-control': 'private, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    },
  });
}

/* ================= AI ================= */
// 使える AI の一覧。サーバーにキーがあるものはそのまま使え、ないものは利用者が自分のキーを入れて使う（ALLOW_USER_KEYS）
const PROVIDERS = {
  gemini: { label: 'Google Gemini', keyVar: 'GEMINI_API_KEY', modelVar: 'GEMINI_MODEL', complexVar: 'GEMINI_MODEL_COMPLEX', model: 'gemini-2.5-flash', complex: 'gemini-2.5-pro' },
  openai: { label: 'OpenAI（ChatGPT）', keyVar: 'OPENAI_API_KEY', modelVar: 'OPENAI_MODEL', complexVar: 'OPENAI_MODEL_COMPLEX', model: 'gpt-4.1-mini', complex: 'gpt-4.1' },
  anthropic: { label: 'Anthropic（Claude）', keyVar: 'ANTHROPIC_API_KEY', modelVar: 'ANTHROPIC_MODEL', complexVar: 'ANTHROPIC_MODEL_COMPLEX', model: 'claude-sonnet-4-5', complex: 'claude-sonnet-4-5' },
  openrouter: { label: 'OpenRouter', keyVar: 'OPENROUTER_API_KEY', modelVar: 'OPENROUTER_MODEL', complexVar: 'OPENROUTER_MODEL_COMPLEX', model: '', complex: '', fixedBase: 'https://openrouter.ai/api/v1' },
  'openai-compatible': { label: 'OpenAI 互換（その他のサービス）', keyVar: 'OPENAI_COMPAT_API_KEY', modelVar: 'OPENAI_COMPAT_MODEL', complexVar: 'OPENAI_COMPAT_MODEL_COMPLEX', model: '', complex: '', baseVar: 'OPENAI_COMPAT_BASE_URL' },
  // Cloudflare の AI（キー不要。wrangler.jsonc の "ai" バインディングで有効になる。無料枠は1日 10,000 ニューロン）
  'workers-ai': { label: 'Cloudflare Workers AI（キー不要）', keyVar: '', modelVar: 'WORKERS_AI_MODEL', complexVar: 'WORKERS_AI_MODEL_COMPLEX', model: '@cf/meta/llama-4-scout-17b-16e-instruct', complex: '@cf/meta/llama-4-scout-17b-16e-instruct', noKey: true },
};
// Workers AI で選べるモデル（画像に対応するのは llama-4-scout と mistral-small）
const WORKERS_AI_MODELS = ['@cf/meta/llama-4-scout-17b-16e-instruct', '@cf/mistralai/mistral-small-3.1-24b-instruct', '@cf/meta/llama-3.3-70b-instruct-fp8-fast'];
const allowUserKeys = env => String(env.ALLOW_USER_KEYS ?? 'true') !== 'false';
// サーバー側の設定（以前の AI_PROVIDER / AI_API_KEY / AI_MODEL もそのまま使える）
function serverProvider(env, id) {
  const P = PROVIDERS[id]; if (!P) return null;
  const legacy = String(env.AI_PROVIDER || '').toLowerCase() === id && env.AI_API_KEY;
  const key = P.noKey ? (env.AI ? 'binding' : '') : (env[P.keyVar] || (legacy ? env.AI_API_KEY : ''));
  const model = env[P.modelVar] || (legacy ? env.AI_MODEL : '') || P.model;
  const complex = env[P.complexVar] || (legacy ? env.AI_MODEL_COMPLEX : '') || (env[P.modelVar] || legacy ? model : P.complex) || model;
  const base = P.fixedBase || (P.baseVar && env[P.baseVar]) || (legacy ? env.AI_BASE_URL : '') || '';
  return { key, model, complex, base: String(base).replace(/\/+$/, '') };
}
function defaultProvider(env) {
  const legacy = String(env.AI_PROVIDER || '').toLowerCase();
  if (PROVIDERS[legacy] && serverProvider(env, legacy).key) return legacy;
  for (const id of Object.keys(PROVIDERS)) if (serverProvider(env, id).key) return id;
  return '';
}
function providerList(env) {
  return Object.entries(PROVIDERS).map(([id, P]) => {
    const sp = serverProvider(env, id);
    return { id, label: P.label, server: !!sp.key, model: sp.model, complex: sp.complex, needsBase: id === 'openai-compatible' && !sp.base, noKey: !!P.noKey };
  });
}
const aiImagesOK = env => String(env.AI_IMAGES ?? 'true') !== 'false';
// リクエストごとに使う AI を決める
function resolveAI(env, body, req) {
  const mock = String(env.AI_PROVIDER || '').toLowerCase() === 'mock' && env.ALLOW_MOCK === '1';
  if (mock && !body.provider) return { provider: 'mock', model: 'mock', complex: 'mock', key: 'x', base: '', maxTokens: 1, images: true, server: true };
  const id = PROVIDERS[body.provider] ? body.provider : defaultProvider(env);
  if (!id) throw new HttpError(400, 'no_ai_selected', 'AIが選ばれていません。「AIの設定」で使うAIを選んでください');
  const sp = serverProvider(env, id);
  const userKey = (req.headers.get('x-user-ai-key') || '').trim();
  let key = sp.key, server = true;
  if (userKey && allowUserKeys(env) && !PROVIDERS[id].noKey) { key = userKey; server = false; }
  if (!key) throw new HttpError(400, 'no_key', PROVIDERS[id].noKey ? 'Workers AI が有効になっていません（wrangler.jsonc の "ai" バインディングを確認して、もう一度 deploy してください）' : `${PROVIDERS[id].label} のAPIキーが設定されていません。「AIの設定」で自分のAPIキーを入れてください`);
  const clean = v => (typeof v === 'string' && /^[\w.:\/@-]{1,120}$/.test(v.trim()) ? v.trim() : '');
  const model = clean(body.model) || sp.model, complex = clean(body.modelComplex) || (clean(body.model) ? clean(body.model) : sp.complex) || model;
  let base = sp.base;
  if (id === 'openai-compatible' && !server && typeof body.baseUrl === 'string' && /^https:\/\/[^\s]+$/.test(body.baseUrl)) base = body.baseUrl.replace(/\/+$/, '');
  if (id === 'openai-compatible' && !base) throw new HttpError(400, 'no_base', 'OpenAI 互換サービスの URL（例: https://openrouter.ai/api/v1）を「AIの設定」で入れてください');
  if (!model) throw new HttpError(400, 'no_model', '使うモデルを「AIの設定」で選んでください');
  return { provider: id, key, model, complex, base, server, maxTokens: int(env.AI_MAX_TOKENS, 16000), images: aiImagesOK(env) };
}
// AI サービスへの通信（つながらないときは分かりやすいエラーにする）
async function aiFetch(url, init) {
  try { return await fetch(url, init); }
  catch (e) { console.log('ai fetch failed', String(url).replace(/key=[^&]+/, 'key=***'), e && e.message); throw new HttpError(502, 'ai_network', 'AIサービスに接続できませんでした（URL やネットワークを確認してください）'); }
}
async function upstreamError(r, name) {
  let detail = ''; try { detail = (await r.text()).slice(0, 2000); } catch {}
  // 各サービスが返す理由（英語）を取り出して画面にも表示する。キーらしき文字列は伏せる
  let reason = '';
  try {
    const d = JSON.parse(detail); const e = d.error || d;
    reason = [e.status || e.type || '', e.message || ''].filter(Boolean).join(': ');
    // OpenRouter は実際の提供元のエラーを metadata に入れて返す（"Provider returned error" の中身）
    const md = e.metadata || {};
    if (md.provider_name) reason += ` ／提供元: ${md.provider_name}`;
    if (md.raw) { let raw = md.raw; try { const r = typeof raw === 'string' ? JSON.parse(raw) : raw; raw = (r.error && (r.error.message || r.error)) || r.message || r; } catch {} reason += ` ／詳細: ${typeof raw === 'string' ? raw : JSON.stringify(raw)}`; }
    if (Array.isArray(md.reasons)) reason += ` ／理由: ${md.reasons.join(', ')}`;
  } catch { reason = detail.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
  reason = reason.replace(/AIza[0-9A-Za-z_\-]{20,}|sk-[0-9A-Za-z_\-]{16,}|sk-ant-[0-9A-Za-z_\-]{16,}/g, '***').slice(0, 500);
  console.log(`${name} error ${r.status}: ${detail.slice(0, 400)}`);
  const tail = reason ? `\n［${name} の応答 ${r.status}］${reason}` : '';
  if (r.status === 429) throw new HttpError(429, 'rate_limited', 'AIサービスの利用上限に達したか、混み合っています。少し待ってから再試行してください' + tail);
  if (r.status === 401 || r.status === 403) throw new HttpError(502, 'ai_auth', 'AIサービスに拒否されました（APIキーの設定を確認してください）' + tail);
  if (r.status === 404) throw new HttpError(502, 'ai_model', 'モデルが見つかりません（「AIの設定」で使えるモデルを選び直してください）' + tail);
  throw new HttpError(502, 'ai_error', `AIサービスでエラーが発生しました（${r.status}）` + tail);
}
async function callOpenAI(c, prompt, images, model, wantJSON) {
  const content = [{ type: 'text', text: prompt }];
  for (const im of images) content.push({ type: 'image_url', image_url: { url: `data:${im.type};base64,${im.data}` } });
  const body = { model, messages: [{ role: 'user', content: images.length ? content : prompt }] };
  if (wantJSON && c.provider === 'openai') body.response_format = { type: 'json_object' };
  const r = await aiFetch((c.base || 'https://api.openai.com/v1') + '/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${c.key}` }, body: JSON.stringify(body),
  });
  if (!r.ok) await upstreamError(r, c.provider);
  const d = await r.json();
  const m = d.choices && d.choices[0] && d.choices[0].message;
  return (m && (typeof m.content === 'string' ? m.content : (m.content || []).map(p => p.text || '').join(''))) || '';
}
async function callWorkersAI(env, c, prompt, images, model) {
  const content = images.length ? [{ type: 'text', text: prompt }, ...images.map(im => ({ type: 'image_url', image_url: { url: `data:${im.type};base64,${im.data}` } }))] : prompt;
  let out;
  try {
    out = await env.AI.run(model, { messages: [{ role: 'user', content }], max_tokens: Math.min(c.maxTokens, 16000) });
  } catch (e) {
    const m = String(e && e.message || e);
    console.log('workers-ai error', m.slice(0, 400));
    if (/neuron|limit|quota|429|capacity/i.test(m)) throw new HttpError(429, 'rate_limited', 'Workers AI の今日の無料枠を使い切ったか、混み合っています（無料枠は日本時間 9:00 にリセット）\n［workers-ai］' + m.slice(0, 200));
    if (/not found|no such model|5007|invalid model/i.test(m)) throw new HttpError(502, 'ai_model', 'Workers AI のモデルが見つかりません（「AIの設定」で選び直してください）\n［workers-ai］' + m.slice(0, 200));
    throw new HttpError(502, 'ai_error', 'Workers AI でエラーが発生しました' + (images.length ? '（画像に対応していないモデルの可能性があります）' : '') + '\n［workers-ai］' + m.slice(0, 200));
  }
  if (out && typeof out.response === 'string') return out.response;
  if (out && out.response && typeof out.response === 'object') return JSON.stringify(out.response);
  const ch = out && out.choices && out.choices[0];
  if (ch && ch.message) return typeof ch.message.content === 'string' ? ch.message.content : JSON.stringify(ch.message.content);
  return typeof out === 'string' ? out : JSON.stringify(out || '');
}
async function callAnthropic(c, prompt, images, model) {
  const content = images.map(im => ({ type: 'image', source: { type: 'base64', media_type: im.type, data: im.data } }));
  content.push({ type: 'text', text: prompt });
  const r = await aiFetch((c.base || 'https://api.anthropic.com') + '/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': c.key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: c.maxTokens, messages: [{ role: 'user', content }] }),
  });
  if (!r.ok) await upstreamError(r, 'anthropic');
  const d = await r.json();
  return (d.content || []).filter(p => p.type === 'text').map(p => p.text).join('');
}
async function callGemini(c, prompt, images, model, wantJSON) {
  const parts = images.map(im => ({ inline_data: { mime_type: im.type, data: im.data } }));
  parts.push({ text: prompt });
  const generationConfig = { maxOutputTokens: c.maxTokens };
  if (wantJSON) generationConfig.responseMimeType = 'application/json';
  const r = await aiFetch(`${c.base || 'https://generativelanguage.googleapis.com/v1beta'}/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': c.key },
    body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig }),
  });
  if (!r.ok) await upstreamError(r, 'gemini');
  const d = await r.json();
  const cand = d.candidates && d.candidates[0];
  if (!cand) throw new HttpError(502, 'ai_blocked', 'AIが応答を返しませんでした（内容がブロックされた可能性があります）');
  return ((cand.content && cand.content.parts) || []).map(p => p.text || '').join('');
}
async function aiCall(req, env, me) {
  const body = await readJSON(req);
  const { prompt, images = [], tier, json: wantJSON } = body;
  if (typeof prompt !== 'string' || !prompt) bad('プロンプトが空です');
  if (prompt.length > 400000) throw new HttpError(413, 'too_large', '送る文章が長すぎます');
  if (!Array.isArray(images) || images.length > 8) bad('画像が多すぎます');
  for (const im of images) if (!im || typeof im.data !== 'string' || !IMG_TYPES.test(String(im.type))) bad('画像の形式が不正です');
  const c = resolveAI(env, body, req);
  if (images.length && !c.images) throw new HttpError(400, 'no_images', 'このサーバーのAIは画像に対応していません');

  // 1日あたりの回数制限（サーバーのキーを使うときだけ。自分のキーなら数えない）
  if (c.server) {
    const limit = int(env.AI_DAILY_LIMIT, 200), day = today();
    const u = await env.DB.prepare('SELECT count FROM ai_usage WHERE user_id = ? AND day = ?').bind(me.id, day).first();
    if (u && u.count >= limit) throw new HttpError(429, 'daily_limit', `今日のAI利用回数の上限（${limit}回）に達しました。自分のAPIキーを使うか、明日またお使いください`);
    await env.DB.prepare('INSERT INTO ai_usage (user_id, day, count) VALUES (?, ?, 1) ON CONFLICT(user_id, day) DO UPDATE SET count = count + 1').bind(me.id, day).run();
  }

  const model = tier === 'complex' ? c.complex : c.model;
  const run = async () => {
    if (c.provider === 'mock') return mockAI(prompt, images, env);
    if (c.provider === 'openai' || c.provider === 'openai-compatible' || c.provider === 'openrouter') return callOpenAI(c, prompt, images, model, wantJSON);
    if (c.provider === 'workers-ai') return callWorkersAI(env, c, prompt, images, model);
    if (c.provider === 'anthropic') return callAnthropic(c, prompt, images, model);
    if (c.provider === 'gemini') return callGemini(c, prompt, images, model, wantJSON);
  };
  // AI の応答には1分以上かかることがある（画像の解析・テスト作成など）。
  // iPad の Safari などは、データが届かないまま約60秒たつと接続を切ってしまうため、
  // すぐに応答を始めて、待っている間は空白を少しずつ送り続ける（JSON の前の空白は読み取りに影響しない）。
  // エラーはこの時点では HTTP の状態コードで返せないので、本文の {"error": {...}} で返す。
  const { readable, writable } = new TransformStream();
  const w = writable.getWriter();
  const send = s => w.write(enc.encode(s)).catch(() => {});
  send(' ');
  const keepAlive = setInterval(() => send(' '), 10000);
  (async () => {
    try {
      const text = await run();
      await send(JSON.stringify({ text, provider: c.provider, model }));
    } catch (e) {
      if (!(e instanceof HttpError)) console.log('ai error', e && e.stack || e);
      const er = e instanceof HttpError ? { status: e.status, code: e.code, message: e.message } : { status: 500, code: 'internal', message: 'サーバー内部でエラーが発生しました' };
      await send(JSON.stringify({ error: er }));
    } finally {
      clearInterval(keepAlive);
      try { await w.close(); } catch {}
    }
  })();
  return new Response(readable, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-inknote': '1', 'x-accel-buffering': 'no' } });
}
// 選んだ AI で使えるモデルの一覧（各サービスの公式 API から取得）
async function aiModels(req, env) {
  const body = await readJSON(req, 10000);
  const c = resolveAI(env, { ...body, model: body.model || 'x' }, req);
  let ids = [];
  if (c.provider === 'workers-ai') {
    return json({ models: WORKERS_AI_MODELS, defaults: { model: serverProvider(env, c.provider).model, complex: serverProvider(env, c.provider).complex } });
  }
  if (c.provider === 'openrouter') {
    const r = await aiFetch(c.base + '/models');
    if (!r.ok) await upstreamError(r, 'models');
    // 無料のモデル（:free）を先に並べる
    const ids = ((await r.json()).data || []).map(m => m.id).sort((a, b) => (b.endsWith(':free') - a.endsWith(':free')) || a.localeCompare(b));
    return json({ models: ids.slice(0, 400), defaults: { model: serverProvider(env, c.provider).model, complex: serverProvider(env, c.provider).complex } });
  }
  if (c.provider === 'openai' || c.provider === 'openai-compatible') {
    const r = await aiFetch((c.base || 'https://api.openai.com/v1') + '/models', { headers: { authorization: `Bearer ${c.key}` } });
    if (!r.ok) await upstreamError(r, 'models');
    const d = await r.json();
    ids = (d.data || []).map(m => m.id);
    if (c.provider === 'openai') ids = ids.filter(x => /^(gpt|o\d|chatgpt)/.test(x) && !/audio|realtime|tts|transcribe|image|embedding|search|moderation|instruct/.test(x));
  } else if (c.provider === 'anthropic') {
    const r = await aiFetch((c.base || 'https://api.anthropic.com') + '/v1/models?limit=100', { headers: { 'x-api-key': c.key, 'anthropic-version': '2023-06-01' } });
    if (!r.ok) await upstreamError(r, 'models');
    ids = ((await r.json()).data || []).map(m => m.id);
  } else if (c.provider === 'gemini') {
    const r = await aiFetch((c.base || 'https://generativelanguage.googleapis.com/v1beta') + '/models?pageSize=200', { headers: { 'x-goog-api-key': c.key } });
    if (!r.ok) await upstreamError(r, 'models');
    ids = ((await r.json()).models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent')).map(m => String(m.name).replace(/^models\//, '')).filter(x => /gemini/.test(x) && !/embedding|tts|image-generation|native-audio/.test(x));
  }
  ids = [...new Set(ids)].sort().slice(0, 300);
  return json({ models: ids, defaults: { model: serverProvider(env, c.provider).model, complex: serverProvider(env, c.provider).complex } });
}
// テスト用（ALLOW_MOCK=1 のときだけ有効）
async function mockAI(prompt, images, env) {
  if (env && env.MOCK_DELAY_MS) await new Promise(r => setTimeout(r, +env.MOCK_DELAY_MS));
  return JSON.stringify({ title: 'テスト', summary: `モック応答（画像${images.length}枚、${prompt.length}文字）`, points: ['要点1'], components: [{ category: 'キーワード', items: ['テスト'] }] });
}

/* ================= web ================= */
function checkUrl(u) {
  let url; try { url = new URL(u); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const h = url.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return null;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || h.startsWith('[')) return null;
  return url;
}
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»', middot: '·', yen: '¥' };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return String.fromCodePoint(n); } catch { return m; } }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
function htmlToText(html) {
  const tm = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = tm ? decodeEntities(tm[1]).replace(/\s+/g, ' ').trim() : '';
  let body = html;
  const main = html.match(/<(article|main)\b[^>]*>([\s\S]*)<\/\1>/i);
  if (main && main[2].length > 1500) body = main[2];
  body = body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|template|iframe|head|nav|footer|form|button|select)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|section|article|main|header|li|ul|ol|table|tr|h[1-6]|blockquote|pre|dd|dt|figure|figcaption)\b[^>]*>/gi, '\n')
    .replace(/<\/(td|th)>/gi, '\t')
    .replace(/<[^>]+>/g, '');
  body = decodeEntities(body).replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { title, text: body };
}
function decodeBody(buf, contentType) {
  let cs = (/charset=([^;]+)/i.exec(contentType || '') || [])[1];
  if (!cs) {
    const head = new TextDecoder('latin1').decode(buf.slice(0, 4096));
    cs = (/<meta[^>]+charset=["']?([\w-]+)/i.exec(head) || [])[1];
  }
  cs = (cs || 'utf-8').trim().toLowerCase();
  try { return new TextDecoder(cs).decode(buf); } catch { return new TextDecoder('utf-8').decode(buf); }
}
async function fetchOne(u) {
  const url = checkUrl(u);
  if (!url) return { error: { url: u, error_type: 'invalid_url', message: 'URLが不正です' } };
  let r;
  try {
    r = await fetch(url.toString(), {
      redirect: 'follow',
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; InkNote/1.0; +https://developers.cloudflare.com/workers/)', accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5', 'accept-language': 'ja,en;q=0.8' },
      cf: { cacheTtl: 300 },
    });
  } catch (e) { return { error: { url: u, error_type: 'fetch_error', message: 'ページに接続できませんでした' } }; }
  if (!r.ok) return { error: { url: u, error_type: 'http_error', message: `ページを取得できませんでした（${r.status}）` } };
  const ct = r.headers.get('content-type') || '';
  if (!/text\/|xhtml|xml|json/i.test(ct)) return { error: { url: u, error_type: 'unsupported', message: 'HTML 以外のファイル（PDF など）は取得できません' } };
  const buf = new Uint8Array(await r.arrayBuffer()).slice(0, 3 * 1024 * 1024);
  const raw = decodeBody(buf, ct);
  const { title, text } = /html|xml/i.test(ct) ? htmlToText(raw) : { title: '', text: raw };
  return { result: { url: r.url || u, title, full_content: text.slice(0, 300000) } };
}
async function webFetch(req, env) {
  const body = await readJSON(req, 100000);
  const urls = (Array.isArray(body.urls) ? body.urls : [body.url]).filter(u => typeof u === 'string').slice(0, 5);
  if (!urls.length) bad('URLがありません');
  if (env.PARALLEL_API_KEY) {
    const r = await fetch('https://api.parallel.ai/v1beta/extract', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env.PARALLEL_API_KEY, 'parallel-beta': 'search-extract-2025-10-10' },
      body: JSON.stringify({ urls, full_content: true, excerpts: false, ...(body.objective ? { objective: String(body.objective).slice(0, 2000) } : {}) }),
    });
    if (r.ok) {
      const d = await r.json();
      if (d.results && d.results.some(x => x.full_content)) return json({ results: d.results, errors: d.errors || [] });
    } else console.log('parallel extract', r.status, (await r.text()).slice(0, 300));
    // うまくいかなければ自前の取得にフォールバック
  }
  const outs = await Promise.all(urls.map(fetchOne));
  return json({ results: outs.filter(o => o.result).map(o => o.result), errors: outs.filter(o => o.error).map(o => o.error) });
}
async function webSearch(req, env) {
  if (!env.PARALLEL_API_KEY) throw new HttpError(503, 'server_unavailable', 'Web検索はこのサーバーで設定されていません');
  const body = await readJSON(req, 100000);
  const queries = (Array.isArray(body.search_queries) ? body.search_queries : []).filter(q => typeof q === 'string' && q).slice(0, 5);
  const r = await fetch('https://api.parallel.ai/v1beta/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': env.PARALLEL_API_KEY, 'parallel-beta': 'search-extract-2025-10-10' },
    body: JSON.stringify({ objective: String(body.objective || queries[0] || '').slice(0, 4000), ...(queries.length ? { search_queries: queries } : {}), max_results: 8, excerpts: { max_chars_per_result: 3000 } }),
  });
  if (!r.ok) { console.log('parallel search', r.status, (await r.text()).slice(0, 300)); throw new HttpError(502, 'server_unavailable', `Web検索に失敗しました（${r.status}）`); }
  return json(await r.json());
}

/* ================= router ================= */
async function route(req, env, url) {
  const p = url.pathname, m = req.method;
  if (p === '/api/config' && m === 'GET') {
    const cnt = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
    const providers = providerList(env), def = defaultProvider(env);
    const ai = !!def || allowUserKeys(env) || (String(env.AI_PROVIDER || '').toLowerCase() === 'mock' && env.ALLOW_MOCK === '1');
    return json({ ai, aiImages: ai && aiImagesOK(env), providers, defaultProvider: def, allowUserKeys: allowUserKeys(env), dailyLimit: int(env.AI_DAILY_LIMIT, 200), search: !!env.PARALLEL_API_KEY, registration: registrationMode(env, cnt ? cnt.n : 0), name: env.SITE_NAME || '' });
  }
  if (m === 'POST') {
    // 他サイトからの書き込みを防ぐ（CSRF対策）
    const origin = req.headers.get('origin');
    if (origin && origin !== url.origin) return fail(403, 'bad_origin', '不正なリクエストです');
    if (p === '/api/register') return register(req, env, url);
    if (p === '/api/login') return login(req, env, url);
    if (p === '/api/logout') return logout(req, env, url);
  }
  const me = await currentUser(req, env);
  if (p.startsWith('/_blob/') && m === 'GET') return me ? serveBlob(env, me, p.slice(7)) : new Response('Unauthorized', { status: 401 });
  if (!me) return fail(401, 'unauthenticated', 'ログインしてください');
  if (p === '/api/me' && m === 'GET') return json(me);
  if (m !== 'POST') return fail(405, 'method', '未対応のメソッドです');
  switch (p) {
    case '/api/password': return changePassword(req, env, url, me);
    case '/api/db': return dbOp(req, env, me);
    case '/api/assets': return uploadAsset(req, env, me);
    case '/api/ai': return aiCall(req, env, me);
    case '/api/ai/models': return aiModels(req, env);
    case '/api/web/fetch': return webFetch(req, env);
    case '/api/web/search': return webSearch(req, env);
  }
  return fail(404, 'not_found', '見つかりません');
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/_blob/')) return env.ASSETS.fetch(req);
    try { return await route(req, env, url); }
    catch (e) {
      if (e instanceof HttpError) return fail(e.status, e.code, e.message);
      console.log('error', e && e.stack || e);
      return fail(500, 'internal', 'サーバー内部でエラーが発生しました');
    }
  },
};
