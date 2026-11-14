# 公開の準備と手順（Firebase）

Topic Studio（TS）は、アプリを Firebase Hosting に置き、Google アカウントでログインして使います（[SPEC.md](SPEC.md) の 3.・14.）。
この手順書は Diary Studio（DS）の docs/DEPLOY.md を元にしています。番号の並びも DS と同じにしてあります（公開のスクリプトとアプリの文が「1 の 7」「3」などの番号で指すため）。

- Firebase のプロジェクトは **Novel Studio（NS）・Diary Studio（DS）とは別** の `topic-studio-1a463` です（作者が 2026-11-14 までに作りました）。
  NS の `novel-studio-3352e`・DS の `diary-studio-35f4e` には触りません。この手順のどこでも、画面の上のプロジェクトの名前が **topic-studio** であることを確かめてから操作してください。
- 無料の **Spark プラン**で、クレジットカードの登録はいりません。
- 作業は **Windows（PowerShell）でも Mac（ターミナル）でも同じ手順・同じコマンド**でできます（コマンドは1行ずつ入力して Enter）。
- 公開先は `https://topic-studio-1a463.web.app` です。

> 今の版（段階0・土台）は、公開すると「起動アニメーション → ログインの画面 → トップ（まだ版はありません）と設定」まで動きます。
> 版（ニュースの一覧）は段階2・3で入ります（[SPEC.md](SPEC.md) の 11.）。
> 段階0から、持ち主の記録（「3. 持ち主のアカウント」）が要ります。記録を作るまでは、ログインしても「持ち主の記録がまだありません（docs/DEPLOY.md の 3）」と出て、トップの画面は出ません。

### 作者がもう済ませたこと（2026-11-14 の時点）

| 手順 | 中身 |
| --- | --- |
| 1 の 3 | Firebase のプロジェクト `topic-studio`（ID `topic-studio-1a463`）を作った |
| 1 の 4 | Authentication の Google ログインをオンにした |
| 1 の 5 | Firestore（Standard エディション・`asia-northeast1`・本番環境モード）を作った |
| 1 の 6 | Hosting を始めた |
| 1 の 7 | Web アプリを登録した。設定値は `src/sync/firebaseConfig.ts` と `.firebaserc` に入れてあります（Claude が入れた） |

### これから作者にお願いすること

1. パソコンの準備（1 の 1。NS・DS の公開で Node.js と Git を入れてあれば、そのままで使えます）
2. リポジトリを取ってくる（1 の 2）
3. Firebase にログインする（1 の 8）
4. 公開する（1 の 9。`npm run deploy`）
5. Google ログインの戻り先を登録する（1 の 10）
6. ログインできるか確かめる（1 の 11）
7. 持ち主の記録を作る（1 の 12。約3分）

## 1. 一度だけ行うこと

### 1. パソコンの準備（Node.js と Git）

NS・DS の公開のために入れてあれば、この手順はいりません（`node -v` が `v22` 以上なら OK）。

1. [Node.js](https://nodejs.org/ja) 24 LTS と [Git](https://git-scm.com/) を入れる。
   - Windows: インストーラーで入れてから、スタートメニューで「PowerShell」を開く
     - 初めての時だけ: PowerShell で `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` を実行し、確かめられたら `Y` を入力して Enter
       （npm のコマンドを動かせるようにする設定。管理者でなくてよい）。終わったら PowerShell を閉じて開き直す
   - Mac: インストーラーで入れてから、「ターミナル」を開く（Git は `git --version` を実行すると入れ方が出る）
   - どちらも `node -v` が `v22` 以上なら OK

### 2. リポジトリを取ってくる

PowerShell・ターミナルで1行ずつ。NS・DS のフォルダーの中ではなく、その横（同じ階層）で行ってください。

```
git clone https://github.com/barraquda-baroq/app-for-topic.git
cd app-for-topic
git checkout ccr-0a293b4b-ell980
npm ci
```

- `npm ci` は数分かかります。
- `git checkout ccr-0a293b4b-ell980` は、まだ main に取り込んでいない段階0の版を使うためです（main に取り込んだ後は要りません。ほかの版を使う時は、Claude の作業の報告に書いてあるブランチの名前にします）。
- この後のコマンドは、いつも `app-for-topic` のフォルダーで打ちます。PowerShell・ターミナルを開き直した時は、先に `cd app-for-topic`。

### 3. Firebase のプロジェクトを作る（済み）

作者が作ったプロジェクトは `topic-studio`（プロジェクト ID **`topic-studio-1a463`**）です。料金のプランは無料の **Spark** のままにしてください
（「アップグレード」「Blaze」のボタンは押さない）。

新しいプロジェクトで作り直す時だけ: DS の docs/DEPLOY.md（リポジトリ `barraquda-baroq/app-for-diary`）の 1 の 3〜6 のとおりに、
プロジェクト・Google ログイン・Firestore・Hosting を作ります（名前は `topic-studio`、Google ログインの「プロジェクトの公開名」は `Topic Studio`、
`diary-studio-35f4e` は新しいプロジェクト ID に読み替える）。この手順書の 4〜6 は「済み」の確かめだけなので、作る手順は DS の物を見てください。
その後、7 の「新しいプロジェクトで作り直した時」で設定値を差し替え、この後の `topic-studio-1a463` を新しいプロジェクト ID に読み替えて 8 から続けます。

### 4. Google ログインをオンにする（Authentication。済み）

確かめるだけ: Firebase コンソールの「Authentication」→「ログイン方法」の一覧で「Google」が「有効」になっている。
「設定」のタブ →「承認済みドメイン」に `topic-studio-1a463.web.app` と `topic-studio-1a463.firebaseapp.com` がある（はじめから入っています。無ければ「ドメインの追加」で足す）。

### 5. Firestore（クラウドの保存先）を作る（済み）

Standard エディション・データベース ID `(default)`・ロケーション `asia-northeast1`（Tokyo）・本番環境モードで作ってあります。
作った直後は誰も読み書きできない状態です。9 の `npm run deploy` で TS のアクセスルール（ログインしたアカウントが持ち主の記録を読めるだけ。[SPEC.md](SPEC.md) の 14.4）に置き換わります。

### 6. Hosting（アプリの置き場所）を始める（済み）

Hosting の画面に `topic-studio-1a463.web.app` が出ていれば OK です（まだ何も置いていないので、開いても TS は出ません）。
**「App Hosting」ではなく「Hosting」** です（App Hosting は有料のプランが要ります）。

### 7. Web アプリを登録して、設定値を差し替える（済み）

Web アプリを登録し、その設定値を `src/sync/firebaseConfig.ts` と `.firebaserc` に入れてあります。今の2つのファイルの形は次のとおりです
（打ち間違いを見比べる時と、作り直した時の見本）。

`src/sync/firebaseConfig.ts`（`export const firebaseConfig = {` から `}` まで。ファイルの上下にはほかの行もあります）:

```ts
export const firebaseConfig = {
  apiKey: 'AIzaSyDjn4BCnbtmCskU8LJYV2VcDZ3nbLJ9WYw',
  authDomain: 'topic-studio-1a463.firebaseapp.com',
  projectId: 'topic-studio-1a463',
  storageBucket: 'topic-studio-1a463.firebasestorage.app',
  messagingSenderId: '660422773523',
  appId: '1:660422773523:web:0b23c983d5a6e3651728e6',
}
```

`.firebaserc`（ファイルの全部）:

```json
{
  "projects": {
    "default": "topic-studio-1a463"
  }
}
```

> この設定値は秘密ではありません（公開したアプリの中にそのまま入り、誰でも見られる物です）。
> データは、9 で公開するアクセスルールで守ります。

確かめる:

```
node scripts/deploy.mjs --check
```

`公開先: https://topic-studio-1a463.web.app（Firebase のプロジェクト topic-studio-1a463）` と出れば OK です。
`✗` の行が出たら、その行のとおりに直してください（何も公開はしません）。

#### 新しいプロジェクトで作り直した時

1. 新しいプロジェクトの Firebase コンソールで、左上の「プロジェクトの概要」→「アプリを追加」→ `</>`（ウェブ）を押す。
   「アプリのニックネーム」は好きな名前（例 `Topic Studio`）。「このアプリの Firebase Hosting も設定します」には **チェックを入れない**。「アプリを登録」。
2. 出てきた設定値の `const firebaseConfig = {` から `};` までをコピーして控え、「コンソールに進む」を押す
   （後からもう一度見る時は、歯車 →「プロジェクトの設定」→「全般」→「マイアプリ」の「SDK の設定と構成」で「構成」を選ぶ）。
3. 控えた値を、2つのファイルに入れます。次のどちらかの方法で（結果は同じ）。

   **A. Claude に頼む（おすすめ）**

   控えた `const firebaseConfig = {` から `};` までを、TS を作っている Claude の会話にそのまま貼って、
   「TS の Firebase の設定をこれに差し替えて」と頼む。Claude が2つのファイルを書き換えてリポジトリに入れるので、
   終わったらパソコンで `git pull` を実行して受け取る。

   **B. 自分で書き換える**

   1. `src/sync/firebaseConfig.ts` をテキストエディターで開く。
      - Windows（PowerShell）: `notepad src\sync\firebaseConfig.ts`
      - Mac（ターミナル）: `open -e src/sync/firebaseConfig.ts`（テキストエディットが開きます。書き換える前に、メニューの「編集」→「自動置換」→
        「スマート引用符」をオフにする。オンのままだと `'` が `’` に変わって動かなくなります）
   2. `export const firebaseConfig = {` の行と `}` の行の間にある6行（`apiKey:` から `appId:` まで）を消して、控えた `apiKey` から `appId` までの6行を貼る。
      `export const firebaseConfig = {` の行、`}` の行、その上下のほかの行はそのまま残す
      （`"` と `'` はどちらでもかまいません。`measurementId` の行があれば、貼っても消してもかまいません）。保存して閉じる。
      書き換えた後の形は、上の見本の値が自分のプロジェクトの物になった物です。
   3. `.firebaserc` を同じように開き（Windows: `notepad .firebaserc`、Mac: `open -e .firebaserc`）、`topic-studio-1a463`
      （仮の値の `topic-studio-xxxx` が入っている時はそれ）を新しいプロジェクト ID に書き換えて保存する。形は上の見本のとおり（`"default":` の値だけを替える）。
   4. 書き換えた2つのファイルは、このパソコンにだけあります。別のパソコンからも公開する時や、後で `git pull` が
      「Your local changes … would be overwritten」と出て止まった時のために、A と同じ方法で Claude にも値を伝え、リポジトリに入れてもらってください
      （入れてもらった後は、このパソコンで `git checkout -- src/sync/firebaseConfig.ts .firebaserc` を実行して自分の書き換えを戻し、`git pull`）。

4. 上の `node scripts/deploy.mjs --check` で確かめる（`公開先:` の行に新しいプロジェクト ID が出れば OK）。

### 8. Firebase にログインする

```
npx firebase login
```

- 「Allow Firebase to collect CLI and Emulator Suite usage and error reporting information?」などと聞かれたら、`n` で Enter（どちらでもかまいません）。
- ブラウザが開くので、`topic-studio` のプロジェクトを作った Google アカウントを選び、「許可」を押す。
- NS・DS の公開のためにこのパソコンでログインしたことがあり、同じアカウントで TS のプロジェクトを作った時は、`Already logged in as …` と出ます（そのままで OK）。

### 9. 公開する

```
npm run deploy
```

型の確かめ → ビルド → アプリ（Hosting）とアクセスルール（Firestore のルール・索引の設定）の公開を、続けて行います（`scripts/deploy.mjs`。数分かかります）。
公開先は `.firebaserc` のプロジェクト（`topic-studio-1a463`）に決めてあるので、NS・DS のプロジェクトへ送ることはありません。
最後に `公開しました: https://topic-studio-1a463.web.app` と出れば完了です。

- 設定値が仮の値のままの時と、2つのファイルのプロジェクト ID が食い違っている時は、何も公開せずに `公開を始める前に止めました` と出て止まり、直す所を出します。
- 途中で止まった時は、`✗` の下に出るよくある原因を見てください（「6. 困った時」にもまとめています）。

> Windows で `npm` を実行して「このシステムではスクリプトの実行が無効になっているため、ファイル …\npm.ps1 を読み込むことができません」と出たら、
> 1 の 1 の `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` を実行してから PowerShell を開き直してください（`npm.cmd`・`npx.cmd` と打っても動きます）。

### 10. Google ログインの戻り先を登録する（最初の1回だけ）

TS は、ログインの画面も `topic-studio-1a463.web.app` で開きます（iPhone のホーム画面のアプリでもログインできるように。DS と同じ）。
そのため、Google 側にその戻り先を教えておきます。これをしないと、ログインの時に「エラー 400: redirect_uri_mismatch」と出ます。

1. [Google Cloud コンソールの「認証情報」](https://console.cloud.google.com/apis/credentials?project=topic-studio-1a463) を開く（Firebase と同じ Google アカウントで）。
   画面の上のプロジェクトの選択が **TS のプロジェクト**（`topic-studio`。ID `topic-studio-1a463`）になっていることを確かめる
   （違う時は押して選び直す。NS の `novel-studio-3352e`・DS の `diary-studio-35f4e` と間違えないように）。
   - 画面が「Google Auth Platform」の形になっている時は、左のメニューの「クライアント」を開く。
2. 「OAuth 2.0 クライアント ID」の一覧の **Web client (auto created by Google Service)** を押す（1 の 4 で Google ログインをオンにした時に、自動で作られています）。
3. 「承認済みのリダイレクト URI」の「URI を追加」で次を足して、「保存」を押す
   （元からある `https://topic-studio-1a463.firebaseapp.com/__/auth/handler` は消さない）。

   ```
   https://topic-studio-1a463.web.app/__/auth/handler
   ```

4. 反映まで数分（長いと数時間）かかることがあります。

### 11. ログインできるか確かめる

1. PC の Chrome か Edge で `https://topic-studio-1a463.web.app` を開く。
2. 起動アニメーション（オレンジの点の新聞と「Topic Studio」）→ ログインの画面 →［Google でログイン］→ 小さなウインドウで Google アカウントを選ぶ。
3. **「持ち主の記録がまだありません（docs/DEPLOY.md の 3）」と［ログアウト］が出れば、ここまでは成功です**（まだ持ち主の記録が無いため。次の 12 で作ります）。
   ログアウトはせずに、このページを開いたままにしておきます。
4. 「エラー 400: redirect_uri_mismatch」と出た時は、10 がまだ反映されていない（しばらく待つ）か、URI の打ち間違いです。

### 12. 持ち主の記録を作る（段階0から。約3分）

11 でログインしたアカウントを、TS の持ち主として Firestore に記録します。手順は「3. 持ち主のアカウント」の「持ち主の記録を作る」です。
作った後に、開いたままの TS のページ（11）に戻る（窓を選ぶ・タブを選ぶ）と、読み込み直さなくてもトップの画面（「まだ版はありません」）が出ます。

ここまでで準備は終わりです。各端末では、次の「2. 各端末で使い始める」のとおりに入れて使います。

## 2. 各端末で使い始める

ログインは、**ふだん使う形（インストールしたアプリ・ホーム画面のアイコン）で開いてから**してください。
ブラウザのタブと、インストールしたアプリ・ホーム画面のアプリとでは、端末の中の保存（ログインの状態など）が別々になることがあるためです（特に iPhone）。
アプリの中の設定 →「ホーム画面に追加（アプリとして使う）」にも同じ手順があります。

### Windows（Chrome・Edge）

1. ふだん使うブラウザで `https://topic-studio-1a463.web.app` を開く。
2. アプリとしてインストールする。スタートメニューやデスクトップから、専用のウインドウで開けるようになります。
   - Chrome: アドレスバーの右端の「インストール」アイコン（画面に下向きの矢印）を押す
     （見当たらない時は右上の「︙」→「キャスト、保存、共有」→「ページをアプリとしてインストール」）
   - Edge: アドレスバーの右にある「アプリをインストール」を押す（見当たらない時は「…」→「アプリ」→「このサイトをアプリとしてインストール」）
3. インストールしたアプリ（スタートメニューの Topic Studio）で［Google でログイン］。

### Android（Chrome）

1. Chrome で `https://topic-studio-1a463.web.app` を開く。
2. 右上の「︙」→「ホーム画面に追加」→「インストール」（「アプリをインストール」と出ることもあります）。
3. ホーム画面（かアプリの一覧）の Topic Studio のアイコン（黒地にオレンジの点の「TS」）から開いて、［Google でログイン］。

### iPhone（Chrome）

iOS 16.4 以降の Chrome なら、ホーム画面に追加して、アプリのように開けます。

1. Chrome で `https://topic-studio-1a463.web.app` を開く。
2. アドレスバーの右の共有のボタン（四角から上向きの矢印）を押す。見当たらない時は、右下の「…」から「共有」を探す。
3. 一覧から「ホーム画面に追加」を押す（見当たらない時は、一覧を上へずらすか「その他」を押す）。
   「Web アプリとして開く」のスイッチが出た時は、オンのまま。
4. 右上の「追加」を押す。
5. **ホーム画面の Topic Studio のアイコンから開いて**、［Google でログイン］。
   ページが Google のログインに切り替わり、アカウントを選ぶと TS に戻ってきます。

Chrome のタブで開いた TS と、ホーム画面のアイコンから開いた TS は、ログインの状態や端末の中の保存が別々です。
いつもホーム画面のアイコンから開いて使ってください。

> Safari で開いた時も、同じ共有のボタン（iOS 26 ではアドレスバーの右の「…」→「共有」）→「ホーム画面に追加」で置けます。

### 一度ログインした端末

- 次からはログインの画面を出さずに、トップの画面が開きます（その端末で持ち主だと確かめた後は、電波が無くても開けます）。
- ログアウトは、歯車（設定）→「アカウント」の［ログアウト］。ログインの画面に戻ります。

## 3. 持ち主のアカウント

TS を使えるのは、「持ち主」のアカウントだけです。
持ち主は、Firestore の `config/owner` の記録（`uid` と `createdAt` の2つの値）で決まります（[SPEC.md](SPEC.md) の 14.4。DS と同じ「形1」）。

- この記録は、**あなたが Firebase コンソールで作ります**（下の「持ち主の記録を作る」。約3分）。TS は段階0から、この記録が要ります。
- アプリには、この記録を作る力も書き換える力もありません（アクセスルール `firestore.rules` で閉じています。作れるのは、Firebase コンソールを開けるあなただけです）。
  そのため、公開した後に、アプリの URL を知った人があなたより先にログインしても、その人が持ち主になることはありません。
- 記録が無い時、アプリはログインの画面に「持ち主の記録がまだありません（docs/DEPLOY.md の 3）」と［ログアウト］だけを出します。
- 持ち主でないアカウントでログインすると、「このアカウントは Topic Studio の持ち主ではありません」と出て、［ログアウト］だけが出ます。何も見えません。
  （拒否された読み取りも無料枠の回数には数えられるため、悪意を持って大量に試されると、その日の読み取りの枠が減ることはあります。）
- その端末で持ち主だと確かめたアカウントでログインしている時だけ、トップの画面が出ます。共用の PC であなたがログアウトした後に、
  ほかの人が自分の Google アカウントでログインしても、トップの画面は出ません。

### 持ち主の記録を作る（一度だけ）

記録には、一度 TS にログインしたアカウントのユーザー UID が要ります（1 の 11 でログインした後に作ります）。

1. [Firebase コンソール](https://console.firebase.google.com/) で TS のプロジェクト（`topic-studio-1a463`）を開く。
   左上のプロジェクトの名前が **topic-studio** であることを確かめる（NS・DS のプロジェクトにも `config` → `owner` があるので、NS・DS の物には触らない）。
2. 左のメニューの「Authentication」→ 上のタブの「ユーザー」を開き、「ID」の列が自分の Gmail のアドレスの行を探す。
   その行の「ユーザー UID」の欄にマウスを乗せ、右に出るコピーのボタンを押す。
3. 左のメニューの「Firestore Database」→ 上のタブの「データ」を開き、いちばん左の列の「＋ コレクションを開始」を押す。
4. 「親のパス」が `/` のまま、「コレクション ID」に `config` と入れて「次へ」。
5. 「ドキュメント ID」に `owner` と入れる（「自動 ID」は押さない）。
6. 1行目は、フィールド `uid`・タイプ `string`・値に 2 でコピーしたユーザー UID。
7. 「＋ フィールドを追加」を押し、2行目は、フィールド `createdAt`・タイプ `timestamp`・値に今日の日付と今のおおよその時刻。
8. 「保存」を押す。

確かめ方: 開いたままの TS のページに戻ると、トップの画面（「まだ版はありません」）が出ます。出ない時は、ページを開き直します。

- 下の「持ち主を変えたい時」のほかは、`config/owner` を消したり書き換えたりしないでください。
- 名前や値を間違えた時は、Firestore の「データ」で直せます（`config` → `owner` の行にマウスを乗せて鉛筆のボタン）。
  よくある間違いは、コレクション ID・ドキュメント ID・フィールドの名前の打ち間違い（`Config`・`Owner`・`UID` など大文字にしない）と、`uid` のタイプを `string` 以外にすることです。

### 持ち主を変えたい時

別の Google アカウントに持ち主を移したい時だけ、次のとおりにします。

1. 新しいアカウントで一度 TS にログインする（「このアカウントは Topic Studio の持ち主ではありません」と出ますが、
   Authentication の「ユーザー」の一覧に新しいアカウントの行ができます）。
2. Firebase コンソールの「Firestore Database」→「データ」で `config` → `owner` を開き、`uid` の行にマウスを乗せて鉛筆のボタンを押し、
   値を新しいアカウントのユーザー UID に書き換えて「更新」を押す。
3. 前の持ち主のアカウントでログインしたままの端末は、ログアウトしてから新しいアカウントでログインし直す
   （前の持ち主のアカウントのままだと、開いた時に「持ち主ではありません」に変わります）。

## 4. 更新する時

新しい版ができたら、公開に使うパソコンで1行ずつ。

```
git pull
npm ci
npm run deploy
```

開いているアプリには「アプリの新しい版があります ［更新する］」の帯が出ます。［更新する］を押すと新しい版に切り替わります（押すまでは、勝手に切り替わりません）。

データの形を変える版（段階1から）の時は、その版の説明に、公開の前にすることを書きます。

## 5. 無料枠の目安（Spark プラン）

| 項目 | 無料枠 | 段階0の TS での使い方 |
| --- | --- | --- |
| Firestore の読み取り | 1日 5万回 | 開いた時と、アプリに戻った時（記録がまだ無い・ほかのアカウントの記録・まだ確かめられていない間だけ）に、持ち主の記録を1回読む |
| Firestore の書き込み・削除 | 1日 2万回ずつ | 使わない（段階1から） |
| Firestore の保存容量 | 1 GiB | 持ち主の記録だけ |
| Hosting の転送量・保存容量 | 1日 360 MB・10 GB | アプリは端末に入れて使うので、受け取るのは新しい版を公開した時だけ |

- Spark プランのままなら、料金はかかりません（枠を超えても請求は来ず、止まるだけです）。

## 6. 困った時

| 出た表示・起きたこと | 直し方 |
| --- | --- |
| `npm run deploy` が「公開を始める前に止めました」と止まる | `✗` の行のとおりに直す（1 の 7）。直したら `node scripts/deploy.mjs --check` で確かめる |
| PowerShell で「…\npm.ps1 を読み込むことができません」 | 1 の 1 の `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` を実行して、PowerShell を開き直す |
| `node`・`npm`・`git` が見つからないと出る | 入れた後に PowerShell・ターミナルを閉じて開き直す。それでも出る時は入れ直す（1 の 1） |
| 公開の途中で「Failed to authenticate」「not logged in」 | `npx firebase login` でログインしてから、もう一度 `npm run deploy`（1 の 8） |
| 公開の途中で「403」「does not have permission」 | プロジェクトを作ったのと別の Google アカウントでログインしています。`npx firebase login:list` で確かめ、`npx firebase logout` の後に `npx firebase login` |
| 公開の途中で「database (default) does not exist」「Cloud Firestore API has not been used」 | Firestore をまだ作っていません（1 の 5）。作った直後なら数分待ってから、もう一度 |
| 公開の途中で、Hosting の site が見つからないと出る | Hosting の「始める」をまだしていません（1 の 6） |
| ログインの時に「エラー 400: redirect_uri_mismatch」 | ログインの戻り先を登録する（1 の 10）。登録した直後なら、しばらく待つ |
| ログインの画面で［Google でログイン］を押すと「まだ公開の準備ができていません（docs/DEPLOY.md）」 | 設定値が差し替え用の仮の値（`REPLACE_` で始まる API キー）のままです。1 の 7 の「新しいプロジェクトで作り直した時」のとおりに設定値を差し替えてから、もう一度 `npm run deploy`（`npm run deploy` は仮の値のままでは公開を始める前に止まるので、ほかの方法で公開した時や開発サーバーで出ます） |
| ログインの画面に「Firebase の設定がまだ仮の値です」 | 設定値の打ち間違い（API キーなど）。1 の 7 の値と見比べて直してから、もう一度 `npm run deploy` |
| ログインの画面に「このアドレスからはログインできません」 | Authentication の「承認済みドメイン」に、開いているアドレス（`topic-studio-1a463.web.app`）を足す（1 の 4） |
| ログインの画面に「ポップアップがブロックされました」 | アドレスバーの右に出るポップアップのアイコンから、このサイトのポップアップを許可する |
| iPhone でログインしたのに、次に開くとログインの画面に戻る | Chrome のタブではなく、ホーム画面のアイコンから開いてログインする（2 の iPhone（Chrome）） |
| 「持ち主の記録がまだありません（docs/DEPLOY.md の 3）」と出る | 持ち主の記録がまだ無いか、場所や名前が違います。「3. 持ち主のアカウント」のとおりに `config` → `owner` → `uid` を作る・直す。直したら TS に戻る（出ない時は開き直す） |
| 「このアカウントは Topic Studio の持ち主ではありません」と出る | `config/owner` の `uid` が、ログインしたアカウントと違います。自分のアカウントなら `uid` の値を自分のユーザー UID に直す。別のアカウントでログインしていたら［ログアウト］して入り直す |
| ログインした後「確かめています…」のまま進まない | 電波が弱いか、Firestore に届いていません。つながると自動で確かめ直します（15秒ごと・つながった時）。それでも進まない時は開き直す |
| iPhone の Chrome の共有の一覧に「ホーム画面に追加」が無い | 一覧を上へずらすか「その他」を押す。それでも無い時は、iOS が 16.4 より前です。iOS を新しくするか、Safari で開いて同じ手順で追加する |

## 7. 開発者向け: エミュレーターで試す

Firebase のエミュレーター（Java 21 以上が必要）で、本物のプロジェクトに触れずにログインを試せます。
エミュレーターのプロジェクトは `demo-topic-studio` です（`firebase.emu.json`。アクセスルールは `firestore.emu.rules`）。

1つ目の画面でエミュレーターを動かしたまま、2つ目の画面で開発サーバーを動かします。

```
npx firebase emulators:start --config firebase.emu.json --only auth,firestore --project demo-topic-studio
```

- Mac（ターミナル）: `VITE_FIREBASE_EMULATOR=127.0.0.1 npm run dev`
- Windows（PowerShell）: `$env:VITE_FIREBASE_EMULATOR="127.0.0.1"; npm run dev`
  （PowerShell の `$env:` はその画面を閉じるまで残ります。開発サーバーはこのための PowerShell の画面で動かし、終わったら画面を閉じてください。
  `npm run deploy` はこの開発用の値を公開するアプリに入れませんが、念のため）

エミュレーターにつないだ開発サーバーでは、［Google でログイン］を押すとエミュレーターの仮のログイン画面が開きます。
エミュレーターにつないだ開発サーバーは持ち主の記録（`config/owner`）を確かめないので（下の `npm run test:e2e:sync` の時を除く）、エミュレーターに `config/owner` を作る必要はありません。

- `npm run test:e2e`（起動アニメーション・ログインの画面・画面の枠などの E2E テスト）は、エミュレーター無しで動きます（開発サーバーだけで使える仮のログインを使う）。
- 持ち主の関所とアクセスルールのテスト（`src/sync/*.emu.test.ts`）は `npm run test:sync` です（エミュレーターを自分で起動して動かすので、上のエミュレーターは止めてから）。
- 持ち主の関所の E2E テスト（`e2e/*.sync.spec.ts`）は `npm run test:e2e:sync` です（これもエミュレーターを自分で起動するので、上のエミュレーターは止めてから）。
  この時の開発サーバーは、`VITE_E2E_OWNER_LOCK=1` を付けて、本番と同じく持ち主の記録を確かめます（テストが管理者の権限で `config/owner` を作ります）。
  この切り替えは開発サーバーだけで効き、`npm run deploy` で公開するアプリには入りません（[SPEC.md](SPEC.md) の 14.4）。
