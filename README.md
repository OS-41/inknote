# 手書きノート 公開版（Cloudflare Workers）

claude.ai の外で、だれでもブラウザ（iPad の Safari など）から使える版です。
画面はこれまでの「手書きノート」と同じで、裏側だけを自分の Cloudflare アカウント上のサーバーに置き換えています。

| 機能 | claude.ai 版 | 公開版 |
|---|---|---|
| 保存 | claude.ai のアカウント | Cloudflare D1（ログインしたユーザーごとに分離） |
| 画像 | claude.ai のアセット | D1（標準）または R2（任意） |
| AI（要約・図表・問題作成・添削・文字認識など） | Claude | Gemini / OpenAI / Anthropic / OpenAI 互換から利用者が選ぶ（「AIの設定」） |
| URL の本文取得 | Parallel Search コネクタ | サーバーが直接取得（Parallel の API キーがあればそちらを優先） |
| Web 検索（関連内容タブ） | Parallel Search コネクタ | Parallel の API キーを設定したときだけ |
| 書き出し・読み込み | ○ | ○（同じ `.inknote.json` 形式なので、claude.ai 版のノートを移せます） |

**サーバーで用意する API キーはサーバー側のシークレットにだけ保存され、ブラウザには送られません。** 利用者が自分のキーを使う場合は、そのキーは利用者の端末にだけ保存されます。

---

## フォルダ構成

```
inknote/
├─ public/            画面（そのまま配信される）
│   ├─ index.html     アプリ本体
│   ├─ shim.js        サーバーとつなぐ部品
│   └─ icon-*.png, manifest.webmanifest   ホーム画面用アイコン
├─ src/worker.js      サーバー（ログイン、保存、AI、URL取得）
├─ schema.sql         データベースの定義
├─ wrangler.jsonc     Cloudflare の設定
└─ package.json
```

---

## 公開までの手順（Mac / Windows 共通）

### 0. 準備
- Cloudflare のアカウント（無料）: https://dash.cloudflare.com/sign-up
- Node.js（LTS 版）: https://nodejs.org/
- AI の API キー（どれか1つ）
  - Google Gemini: https://aistudio.google.com/ （無料枠あり）
  - OpenAI: https://platform.openai.com/
  - Anthropic: https://console.anthropic.com/

### 1. ダウンロードしたフォルダでインストール
ターミナルで zip を展開したフォルダに移動して:
```sh
npm install
npx wrangler login        # ブラウザが開くので Cloudflare にログインして許可
```

### 2. データベースを作る
```sh
npx wrangler d1 create inknote
```
表示された `database_id = "xxxxxxxx-…"` を、`wrangler.jsonc` の
`"database_id": "ここに database_id を貼り付け"` の部分に貼り付けます。続けて:
```sh
npm run db:init
```

### 3. AI を設定する
使える AI は **Google Gemini / OpenAI（ChatGPT）/ Anthropic（Claude）/ OpenRouter / OpenAI 互換サービス / Cloudflare Workers AI** の6種類です。

**Cloudflare Workers AI はキー不要です。** `wrangler.jsonc` の `"ai": { "binding": "AI" }` があれば、deploy するだけで使えます（Cloudflare の無料枠は1日 10,000 ニューロン、毎日 9:00（日本時間）にリセット。超えた分は有料プランが必要）。ほかの AI のキーを登録していなければ、これが既定になります。標準のモデルは `@cf/meta/llama-4-scout-17b-16e-instruct`（画像にも対応）です。日本語の問題作成や手書きの読み取りの精度は、Gemini などの大手のモデルより落ちることがあります。
利用者はアプリの左のメニューにある「**AIの設定**」で、どれを使うか・どのモデルを使うかを選べます。

AI を使う方法は2つあり、組み合わせられます。

**(a) サーバーのキーで提供する**（利用者はキー不要。1人1日 `AI_DAILY_LIMIT` 回まで）
使わせたい AI のキーだけをシークレットに登録します:
```sh
npx wrangler secret put GEMINI_API_KEY        # Gemini
npx wrangler secret put OPENAI_API_KEY        # OpenAI
npx wrangler secret put ANTHROPIC_API_KEY     # Anthropic
npx wrangler secret put OPENROUTER_API_KEY    # OpenRouter（https://openrouter.ai/ でキーを作成。モデルは OPENROUTER_MODEL か「AIの設定」で選ぶ）
npx wrangler secret put OPENAI_COMPAT_API_KEY # OpenAI 互換（wrangler.jsonc の OPENAI_COMPAT_BASE_URL と OPENAI_COMPAT_MODEL も設定）
```
キーを登録した AI が「サーバーのキーで利用可」と表示されます。複数使える場合の最初の既定は Gemini → OpenAI → Anthropic → OpenRouter → 互換 → Workers AI の順です（利用者は「AIの設定」でいつでも切り替えられます）。

**(b) 利用者が自分のキーを使う**（`ALLOW_USER_KEYS` が `true` のとき。標準で有効）
「AIの設定」で自分の API キーを入れると、そのキーで呼び出します。キーはその端末のブラウザにだけ保存され、サーバーには保存されません（呼び出しのたびにサーバーを経由して各サービスへ送られます）。自分のキーを使う場合、回数制限はかかりません。
無効にするには `wrangler.jsonc` の `ALLOW_USER_KEYS` を `"false"` にします。

モデルは「AIの設定」の「一覧」ボタンで、各サービスから使えるモデルの一覧を取得して選べます。空欄なら標準モデルを使います。
標準モデルは `GEMINI_MODEL` などの設定で変えられます。空欄の場合は組み込みの既定値（作成時点のもの）を使いますが、モデル名は各サービスで随時変わるので、公開前に「AIの設定」の「接続テスト」で動くことを確認してください。

以前の設定方法（`AI_PROVIDER` / `AI_API_KEY` / `AI_MODEL`）も引き続き使えます。

### 4. だれが使えるかを決める
- **自分だけで使う**: 何もしなくて大丈夫です。最初に登録した1人だけがアカウントを作れ、以降の新規登録は閉じます。
- **友人などにも使ってもらう**: 招待コード（合言葉）を設定します。登録画面で招待コードを入れた人だけが登録できます。
  ```sh
  npx wrangler secret put INVITE_CODE
  ```
  AI の利用回数は `AI_DAILY_LIMIT`（1人1日あたり、標準 200 回）で制限されます。

### 5. （任意）Web 検索を有効にする
Parallel の API キー（https://platform.parallel.ai/ ）を登録すると、関連内容タブの「Webで探す」が使えるようになり、URL 取得の精度も上がります。
```sh
npx wrangler secret put PARALLEL_API_KEY
```

### 6. 公開
```sh
npm run deploy
```
最後に `https://inknote.<あなたのサブドメイン>.workers.dev` のような URL が表示されます。

### 7. iPad で使う
1. Safari で上の URL を開き、「新規登録」でアカウントを作る
2. 共有ボタン →「ホーム画面に追加」で、アプリのように全画面で使えます

---

## claude.ai 版からノートを移す
1. claude.ai 版で「書き出し」→ `.inknote.json` を保存
2. 公開版で「読み込み」→ そのファイルを選ぶ（画像も含めて取り込まれます）

## 更新するとき
`public/index.html` などを新しいものに差し替えて `npm run deploy` するだけです。データはそのまま残ります。

## 手元で試す
```sh
cp .dev.vars.example .dev.vars    # GEMINI_API_KEY などを書き込む
npm run db:init:local
npm run dev                       # http://localhost:8787
```

---

## 設定一覧（wrangler.jsonc の vars）
| 名前 | 内容 | 標準 |
|---|---|---|
| `SITE_NAME` | ログイン画面に出す説明 | 空 |
| `GEMINI_MODEL` / `OPENAI_MODEL` / `ANTHROPIC_MODEL`（と `_COMPLEX`） | 各AIの標準モデル | 組み込みの既定値 |
| `OPENAI_COMPAT_BASE_URL` / `OPENAI_COMPAT_MODEL` | OpenAI 互換サービスの URL とモデル | 空 |
| `ALLOW_USER_KEYS` | 利用者が自分の API キーを使えるようにする | `true` |
| `AI_IMAGES` | 画像を AI に送るか（画像非対応モデルなら `false`） | `true` |
| `AI_MAX_TOKENS` | 応答の最大トークン数（Anthropic / Gemini） | 16000 |
| `AI_DAILY_LIMIT` | 1人1日あたりの AI 呼び出し回数（サーバーのキーを使うときだけ） | 200 |
| `MAX_STORAGE_MB_PER_USER` | 1人あたりの画像保存容量（MB） | 300 |
| `PBKDF2_ITERATIONS` | パスワードのハッシュ強度（最大 100000） | 20000 |

シークレット（`wrangler secret put` で登録）: `GEMINI_API_KEY`・`OPENAI_API_KEY`・`ANTHROPIC_API_KEY`・`OPENAI_COMPAT_API_KEY`（使うものだけ）、`INVITE_CODE`、`PARALLEL_API_KEY`

## 画像を R2 に置く（任意）
画像が多くなる場合は R2 のほうが向いています（無料枠 10GB/月。初回はカード登録を求められることがあります）。
```sh
npx wrangler r2 bucket create inknote-images
```
`wrangler.jsonc` の `r2_buckets` のコメントを外して `npm run deploy`。
※ 切り替え前に D1 に保存した画像は D1 から読まれなくなるため、使い始める前に決めるのがおすすめです。

## 無料プランの目安
- Worker の呼び出し 1日 10 万回（画面ファイルの配信は数えられません）
- D1: 1データベース 500MB
- Worker の CPU 時間は 1 回 10ms。パスワードのハッシュ強度を上げすぎたり、非常に大きなページを取得したりすると失敗することがあります（その場合は `PBKDF2_ITERATIONS` を下げるか、有料プランに）。
- AI の料金は、選んだ AI サービス側で発生します。

## セキュリティについて
- ログインは Cookie（HttpOnly / Secure / SameSite=Lax）。トークンは SHA-256 にしてから保存
- パスワードは PBKDF2-SHA256 + ソルト
- ログイン失敗が 15 分で 10 回を超えると一時的にロック
- 画像を含むすべてのデータは、ログインしたユーザー本人しか読めません
- 他サイトからの書き込み（CSRF）は Origin ヘッダーで拒否

---

## GitHub Codespaces から公開・更新する
Mac に何も入れなくても、GitHub の Codespaces（ブラウザ上の開発環境）から `npm run deploy` できます。

### 最初の1回
1. **Cloudflare の API トークンを作る**
   https://dash.cloudflare.com/profile/api-tokens →「トークンを作成」→ テンプレート「**Edit Cloudflare Workers**」→ アカウントを選んで作成。
   表示されたトークンをコピーします（一度しか表示されません）。
   ※ D1（データベース）の操作もするので、権限に「D1: 編集」が含まれているか確認し、なければ追加します。
2. **アカウント ID を確認する**
   Cloudflare ダッシュボードの「Workers & Pages」画面の右側にある「アカウント ID」をコピーします。
3. **GitHub に登録する**
   リポジトリの「Settings」→「Secrets and variables」→「Codespaces」→「New repository secret」で、次の2つを登録します。
   - `CLOUDFLARE_API_TOKEN`：1 のトークン
   - `CLOUDFLARE_ACCOUNT_ID`：2 の ID

### 公開・更新するとき
1. リポジトリの「Code」→「Codespaces」→「Create codespace on main」（2回目以降は既存の codespace を開く）。
2. 下のターミナルで:
   ```sh
   npm run deploy
   ```
   （`npm install` は codespace を作ったときに自動で実行されます）
3. 変更をコミットしたら `git push` で GitHub にも反映します。

API キーなどのシークレット（`GEMINI_API_KEY` など）は Cloudflare 側に保存されているので、リポジトリには入れません。追加・変更するときは codespace のターミナルで `npx wrangler secret put 名前` を実行します。

---

## GitHub Actions で自動 deploy する
`main` ブランチに push すると、GitHub Actions（`.github/workflows/deploy.yml`）が自動で `wrangler deploy` を実行します。README や `.devcontainer` だけの変更では実行されません。

### 最初の1回
リポジトリの「Settings」→「Secrets and variables」→「**Actions**」→「New repository secret」で、次の2つを登録します（Codespaces 用とは別の場所なので、両方に登録が必要です）。
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

### 使い方
- ふだんは、変更をコミットして `main` に push するだけで公開されます。
- 手動で実行したいときは、「Actions」タブ →「Deploy to Cloudflare」→「Run workflow」。
- 結果は「Actions」タブで確認できます（失敗すると GitHub からメールが届きます）。
- データベースの表を変えたとき（`schema.sql` の変更）は、自動では反映されません。codespace で `npm run db:init` を実行してください。

