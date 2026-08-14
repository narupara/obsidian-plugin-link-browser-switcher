// ============================================================
// main.js  ―  Link Browser Switcher（リンクのブラウザ使い分けプラグイン）
// ============================================================
// 【このプラグインが行うこと】
//   Obsidianのノート内にある外部リンク（http:// や https:// で始まるリンク）を
//   クリックしたとき、押しているキーの組み合わせによって
//   「どのブラウザで開くか」を切り替えます。
//
//     素クリック         : Obsidian標準の動作（既定のブラウザで開く）
//     Ctrl+クリック       : 設定画面で指定した「ブラウザA」で開く
//     Ctrl+Shift+クリック : 設定画面で指定した「ブラウザB」で開く
//
//   ※ ノート同士の内部リンク（[[ノート名]]など）は対象外です。
//     http/https で始まる外部リンクだけが対象になります。
//
// 【使い方】
//   1. このフォルダ（link-browser-switcher）ごと、Obsidianの Vault の中の
//      「.obsidian/plugins/」フォルダにコピーする。
//   2. Obsidianを再起動する（または設定画面の「コミュニティプラグイン」で更新）。
//   3. 設定 → コミュニティプラグイン → 「Link Browser Switcher」を有効化する。
//   4. 設定画面の「Link Browser Switcher」タブで、ブラウザA・ブラウザBの
//      実行ファイルのパスを入力する。
//   5. ノート内の外部リンクを Ctrl+クリック / Ctrl+Shift+クリック すると
//      指定したブラウザで開く。
//
// 【動作確認・不具合調査のしかた（デバッグモード）】
//   下の「カスタマイズゾーン」にある DEBUG_MODE を true にしておくと、
//   Obsidianの開発者ツール（Ctrl+Shift+I）の「Console」タブに、
//   プラグインの動きが逐一 [LBS] という目印付きで表示されます。
//
//   確認できる内容の例:
//     - プラグインが起動処理を開始/完了したか
//     - 設定(data.json)がどう読み込まれたか（中身も表示）
//     - リンクをクリックしたときに、そもそもクリックを検知できているか
//     - 検知した場合、どのキーの組み合わせと判定されたか
//     - 指定ブラウザのパスが存在するかどうかの確認結果
//     - ブラウザの起動に成功したか、失敗したなら何のエラーか
//
//   問題が解決したら DEBUG_MODE を false に戻すとログが出なくなります。
//
// 【初回セットアップ】
//   特別なインストール作業は不要です（pip installのようなコマンドはありません）。
//
// 【注意】
//   このプラグインは Windows / Mac のデスクトップ版 Obsidian専用です。
// ============================================================


// ===== Obsidian・Node.jsの機能を読み込む =====
const { Plugin, PluginSettingTab, Setting, Notice, MarkdownView } = require('obsidian');
const { execFile } = require('child_process');
const fs = require('fs');


// ============================================================
// ▼▼▼ カスタマイズゾーン ここを変えるだけで設定が変わります ▼▼▼
// ============================================================

// 【デバッグモード】
// true にすると、開発者ツールのConsoleタブに動作ログが詳しく出るようになる。
// 不具合調査が終わったら false に戻すことを推奨（false でも動作自体は同じ）。
const DEBUG_MODE = false;

// 【ログ出力用の小さな関数】
// DEBUG_MODEがtrueのときだけ、[LBS] という目印を付けてconsole.logに出力する。
// 目印を付けることで、開発者ツールのConsoleで他のログに紛れず検索しやすくなる。
function debugLog(...args) {
  if (DEBUG_MODE) {
    console.log('[LBS]', ...args);
  }
}

// 【ブラウザの割り当て一覧】
// どのキーの組み合わせに、どのブラウザ枠（設定画面の入力欄）を割り当てるかを
// ここで定義する。
//
// ★ 新しい組み合わせ（例: Ctrl+Alt+クリック → ブラウザC）を追加したい場合:
//   下の配列に、以下のような項目をコピーして追記するだけでよい。
//     {
//       id: 'browserC',
//       label: 'ブラウザC',
//       modifierDesc: 'Ctrl+Alt+クリック',
//       ctrlKey: true,
//       shiftKey: false,
//       altKey: true,
//     },
const BROWSER_SLOTS = [
  {
    id: 'browserA',
    label: 'ブラウザA',
    modifierDesc: 'Ctrl+クリック',
    ctrlKey: true,
    shiftKey: false,
    altKey: false,
  },
  {
    id: 'browserB',
    label: 'ブラウザB',
    modifierDesc: 'Ctrl+Shift+クリック',
    ctrlKey: true,
    shiftKey: true,
    altKey: false,
  },
  // ▼ 新しいブラウザの割り当てを追加する場合はここに追記する
];

// 【設定の初期値】
const DEFAULT_BROWSER_NAMES = {
  browserA: 'Comet',
  browserB: 'Brave',
};

function buildDefaultSettings() {
  const settings = { browsers: {} };
  for (const slot of BROWSER_SLOTS) {
    settings.browsers[slot.id] = {
      name: DEFAULT_BROWSER_NAMES[slot.id] || slot.label,
      path: '',
    };
  }
  return settings;
}

// ============================================================
// ▲▲▲ カスタマイズゾーン ここまで ▲▲▲
// ============================================================


// ===== メインのプラグインクラス =====
module.exports = class LinkBrowserSwitcherPlugin extends Plugin {

  // onload(): プラグインが有効化されたときに一度だけ呼ばれる「起動処理」。
  async onload() {
    debugLog('onload() 開始');

    // -------------------------------------------------------
    // 【起動処理全体を try/catch で保護】
    // 万が一ここで例外が起きると、プラグインが app.plugins.plugins に
    // 登録されないまま静かに失敗し、「コンソールで settings を見ても
    // 何も反応がない」という今回のような状況になる。
    // それに気づけるよう、失敗した場合は必ずNoticeで目立つ通知を出す。
    // -------------------------------------------------------
    try {
      await this.loadSettings();
      debugLog('設定の読み込み完了:', JSON.stringify(this.settings));

      this.addSettingTab(new LinkBrowserSwitcherSettingTab(this.app, this));
      debugLog('設定タブを登録しました');

      // キャプチャフェーズ(true)でdocument全体のクリックを監視する。
      this.registerDomEvent(document, 'click', this.handleClick.bind(this), true);
      debugLog('クリックイベントの監視を開始しました');

      if (DEBUG_MODE) {
        new Notice('[LBS] Link Browser Switcher: 起動完了（デバッグモード）');
      }
    } catch (error) {
      // ここに来た場合、プラグインは正常に起動できていない。
      console.error('[LBS] onload() でエラーが発生しました:', error);
      new Notice(
        `❌ Link Browser Switcher の起動に失敗しました。\n` +
          `data.json が壊れている可能性があります。\n` +
          `詳細: ${error && error.message ? error.message : error}`
      );
      // 起動が失敗した以上、それ以降の処理は行わない
      return;
    }

    debugLog('onload() 完了');
  }

  onunload() {
    debugLog('onunload() 呼び出し');
  }

  // ----------------------------------------------------------
  // 【設定の読み込み・保存】
  // ----------------------------------------------------------

  async loadSettings() {
    let saved = null;

    // loadData() 自体がJSON解析に失敗すると例外を投げることがあるため、
    // ここでも個別にtry/catchし、原因を特定しやすくする。
    try {
      saved = await this.loadData();
      debugLog('loadData() の生の戻り値:', saved);
    } catch (error) {
      console.error('[LBS] loadData() の読み込みに失敗しました（data.jsonが壊れている可能性）:', error);
      new Notice(
        `❌ 設定ファイル(data.json)の読み込みに失敗しました。\n` +
          `JSONとして不正な形式になっている可能性があります。\n` +
          `詳細: ${error && error.message ? error.message : error}`
      );
      saved = null; // 読み込めなかった場合は初期値で進める
    }

    const defaults = buildDefaultSettings();

    if (!saved) {
      this.settings = defaults;
      debugLog('保存データが無いため初期値を使用します');
      return;
    }

    this.settings = { browsers: {} };
    for (const slot of BROWSER_SLOTS) {
      this.settings.browsers[slot.id] = Object.assign(
        {},
        defaults.browsers[slot.id],
        (saved.browsers && saved.browsers[slot.id]) || {}
      );
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
    debugLog('設定を保存しました:', JSON.stringify(this.settings));
  }

  // ----------------------------------------------------------
  // 【クリック処理の本体】
  // ----------------------------------------------------------

  handleClick(evt) {
    // -------------------------------------------------------
    // 【調査用ログ：すべてのクリックを記録する】
    // 通常運用では不要なログだが、「リンクとして認識されない」という
    // 不具合を調べるため、クリックされた要素の情報を必ず出力する。
    // target.tagName（HTML要素の種類）や className、closest('a')の結果を見て、
    // 実際にどんな要素がクリックされているかを確認できる。
    // 原因調査が終わったら、このブロックは削除するか、
    // DEBUG_MODE の条件で囲んでもよい。
    // -------------------------------------------------------
    if (DEBUG_MODE) {
      const t = evt.target;
      const anchorForLog = t && t.closest ? t.closest('a') : null;
      console.log(
        '[LBS][全クリック調査]',
        'button=', evt.button,
        'target.tagName=', t && t.tagName,
        'target.className=', t && t.className,
        'closest(a)が見つかったか=', !!anchorForLog,
        'closest(a)のhref=', anchorForLog ? anchorForLog.getAttribute('href') : null,
        'ctrlKey=', evt.ctrlKey,
        'shiftKey=', evt.shiftKey
      );
    }

    // 左クリック以外（右クリック等）は対象外
    if (evt.button !== 0) {
      return;
    }

    // -------------------------------------------------------
    // 【URLの取得：2つの方式を順番に試す】
    //
    // 方式①: 通常の<a href="...">タグから取得する
    //   → プレビュー（閲覧）モードや、ノート上部のプロパティ欄など、
    //     本物の<a>タグとして描画されている場合に使える。
    //
    // 方式②: エディタAPI(getClickableTokenAt)を使って取得する
    //   → 編集画面のLive Previewモードでは、リンクが<a>タグではなく
    //     <span class="cm-underline">のような要素で描画されており、
    //     href属性を直接読み取ることができない。
    //     そのため、Obsidian標準の「クリック位置にあるリンクの中身を返す」
    //     API を使って解決する（詳細は resolveLiveViewLinkAt を参照）。
    // -------------------------------------------------------
    const anchor = evt.target && evt.target.closest ? evt.target.closest('a') : null;
    let href = anchor ? anchor.getAttribute('href') : null;
    let sourceForLog = 'aタグ';

    if (!href) {
      href = this.resolveLiveViewLinkAt(evt);
      sourceForLog = 'Live Previewエディタ';
    }

    debugLog(
      'リンククリックを検知:',
      'href=', href,
      '取得元=', sourceForLog,
      'ctrlKey=', evt.ctrlKey,
      'shiftKey=', evt.shiftKey,
      'altKey=', evt.altKey
    );

    if (!href || !/^https?:\/\//i.test(href)) {
      debugLog('→ 対象外(URLを取得できなかった、またはhttp/httpsで始まらないリンク)。処理をスキップ');
      return;
    }

    if (!evt.ctrlKey && !evt.shiftKey && !evt.altKey) {
      debugLog('→ 修飾キーなしの素クリック。Obsidian標準の動作に任せる');
      return;
    }

    const matchedSlot = BROWSER_SLOTS.find((slot) => {
      return (
        slot.ctrlKey === evt.ctrlKey &&
        slot.shiftKey === evt.shiftKey &&
        slot.altKey === evt.altKey
      );
    });

    if (!matchedSlot) {
      debugLog('→ 対応するキーの組み合わせが見つかりませんでした(BROWSER_SLOTS未定義の組み合わせ)');
      return;
    }

    debugLog('→ 一致したブラウザ枠:', matchedSlot.id, matchedSlot.label);

    evt.preventDefault();
    evt.stopPropagation();

    this.openWithBrowserSlot(matchedSlot, href);
  }

  /**
   * 【関数の役割】
   * 編集画面のLive Previewモードでは、リンクが本物の<a href="...">タグではなく
   * <span class="cm-underline">のような「見た目だけリンク風」の要素で
   * 描画されており、href属性からURLを直接読み取れない。
   *
   * そこで、クリックされた画面上の位置をエディタ内の文字位置に変換し、
   * Obsidian標準のエディタAPI「getClickableTokenAt」を使って、
   * その位置にあるリンクの中身（URLなど）を取得する。
   *
   * 【仕組み】
   *   1. クリックされた要素がエディタ(.cm-editor)の中かどうかを確認する
   *   2. 現在アクティブなノートのエディタを取得する
   *   3. editor.cm （Obsidian内部のCodeMirror6インスタンス。
   *      ※これは公式ドキュメントに載っていない内部APIだが、多くのプラグインで
   *      実績のある方法。将来のObsidianアップデートで使えなくなる可能性は
   *      ゼロではないため、必ず try/catch と存在チェックで保護する）
   *      を使って、クリックされたDOM要素からドキュメント内の文字位置を求める
   *   4. その位置にある「クリック可能なトークン」(リンク・タグなど)を取得する
   *   5. トークンの中身がURL(http/httpsで始まる文字列)であれば、それを返す
   *
   * 【引数】
   * evt: クリックイベント
   *
   * 【戻り値】
   * URL文字列。取得できない場合は null。
   */
  resolveLiveViewLinkAt(evt) {
    try {
      // クリックされた要素が、エディタ(CodeMirror6)の中かどうかを確認する。
      // "cm-editor" は CodeMirror6 のルート要素に付くクラス名。
      const inEditor = evt.target && evt.target.closest && evt.target.closest('.cm-editor');
      if (!inEditor) {
        debugLog('resolveLiveViewLinkAt: エディタ内のクリックではないため対象外');
        return null;
      }

      // 現在アクティブな「ノートを編集するビュー」を取得する
      const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!markdownView || !markdownView.editor) {
        debugLog('resolveLiveViewLinkAt: アクティブなMarkdownエディタが見つかりません');
        return null;
      }
      const editor = markdownView.editor;

      // editor.cm : Obsidian内部のCodeMirror6インスタンス（非公式・内部API）。
      // バージョン差異で存在しない場合に備えて必ずチェックする。
      const cm = editor.cm;
      if (!cm) {
        debugLog('resolveLiveViewLinkAt: editor.cm（内部API）が利用できません。Obsidianのバージョンをご確認ください');
        return null;
      }

      // -------------------------------------------------------
      // 【文字位置(offset)の求め方】
      // 当初 posAtDOM(要素) を使っていたが、これは「クリックされた要素の
      // 先頭位置」を返すため、リンクのすぐ境界（開始位置ギリギリ）になり、
      // getClickableTokenAt が「リンクの外」と判定して null を返すことがあった。
      //
      // 代わりに posAtCoords(実際にクリックされた画面座標) を使うことで、
      // クリックした場所そのものに対応する文字位置を求める（境界に乗りにくい）。
      // posAtCoords が使えない古いバージョン等に備えて posAtDOM にフォールバックする。
      // -------------------------------------------------------
      let offset = null;
      if (typeof cm.posAtCoords === 'function') {
        offset = cm.posAtCoords({ x: evt.clientX, y: evt.clientY });
        debugLog('resolveLiveViewLinkAt: posAtCoordsで取得したoffset=', offset);
      }
      if (offset === null || offset === undefined) {
        if (typeof cm.posAtDOM === 'function') {
          offset = cm.posAtDOM(evt.target);
          debugLog('resolveLiveViewLinkAt: posAtDOM(フォールバック)で取得したoffset=', offset);
        }
      }
      if (offset === null || offset === undefined) {
        debugLog('resolveLiveViewLinkAt: 文字位置を取得できませんでした');
        return null;
      }

      // getClickableTokenAt: クリック位置にある「クリック可能なトークン」
      // （外部リンク・内部リンク・タグなど）の情報を返す、Obsidian標準のAPI。
      if (typeof editor.getClickableTokenAt !== 'function') {
        debugLog('resolveLiveViewLinkAt: getClickableTokenAt が利用できません(Obsidianのバージョンが古い可能性があります)');
        return null;
      }

      // -------------------------------------------------------
      // 【境界のずれ対策：前後にずらして再試行する】
      // offsetがリンクの境界ちょうどにあたっていると null が返ることがあるため、
      // 同じoffset → 1文字後ろ → 1文字前 の順で試し、最初に見つかったリンクを採用する。
      // -------------------------------------------------------
      const offsetsToTry = [offset, offset + 1, offset - 1];
      for (const tryOffset of offsetsToTry) {
        if (tryOffset < 0) continue;
        const pos = editor.offsetToPos(tryOffset);
        const token = editor.getClickableTokenAt(pos);
        debugLog('resolveLiveViewLinkAt: offset=', tryOffset, ' getClickableTokenAtの結果=', token);

        if (token && token.text && /^https?:\/\//i.test(token.text)) {
          return token.text;
        }
      }

      return null;
    } catch (error) {
      // 内部APIに依存している部分なので、Obsidianのバージョンによっては
      // ここで例外が起きる可能性がある。その場合もツール全体を止めないようにする。
      console.error('[LBS] resolveLiveViewLinkAt でエラーが発生しました:', error);
      return null;
    }
  }

  openWithBrowserSlot(slot, url) {
    const browserSetting = this.settings.browsers[slot.id];
    const browserName = (browserSetting && browserSetting.name) || slot.label;
    const browserPath = browserSetting && browserSetting.path;

    debugLog('openWithBrowserSlot() 呼び出し:', 'slot=', slot.id, 'path=', browserPath, 'url=', url);

    if (!browserPath) {
      debugLog('→ パス未設定。既定ブラウザにフォールバックします');
      new Notice(
        `⚠️ 「${browserName}」の実行ファイルパスが設定タブで未設定です。\n` +
          `既定のブラウザで開きます。`
      );
      this.openWithDefaultBrowser(url);
      return;
    }

    let exists = false;
    try {
      exists = fs.existsSync(browserPath);
    } catch (error) {
      console.error('[LBS] fs.existsSync でエラー:', error);
      exists = false;
    }
    debugLog('→ fs.existsSync の結果:', exists);

    if (!exists) {
      new Notice(
        `❌ 「${browserName}」の実行ファイルが見つかりません。\n` +
          `設定タブでパスを確認してください。\n(${browserPath})`
      );
      this.openWithDefaultBrowser(url);
      return;
    }

    debugLog('→ execFile を実行します:', browserPath, [url]);
    execFile(browserPath, [url], (error) => {
      if (error) {
        console.error('[LBS] execFile 失敗:', error);
        new Notice(`❌ 「${browserName}」の起動に失敗しました。\n${error.message}`);
        this.openWithDefaultBrowser(url);
      } else {
        debugLog('→ execFile 成功:', browserName);
      }
    });
  }

  openWithDefaultBrowser(url) {
    debugLog('openWithDefaultBrowser() 呼び出し:', url);
    window.open(url, '_blank');
  }
};


// ============================================================
// ===== 設定タブ =====
// ============================================================

class LinkBrowserSwitcherSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Link Browser Switcher 設定' });

    containerEl.createEl('p', {
      text:
        '外部リンク（http / https）をクリックする際、押しているキーの組み合わせに' +
        'よって開くブラウザを切り替えます。',
    });

    const ul = containerEl.createEl('ul');
    ul.createEl('li', { text: '素クリック : 既定のブラウザ（Obsidian標準の動作）' });
    for (const slot of BROWSER_SLOTS) {
      ul.createEl('li', { text: `${slot.modifierDesc} : ${slot.label}` });
    }

    for (const slot of BROWSER_SLOTS) {
      containerEl.createEl('h3', { text: `${slot.label}（${slot.modifierDesc}）` });

      new Setting(containerEl)
        .setName('表示名')
        .setDesc('通知メッセージ等に表示される名前（例: Comet, Brave など）')
        .addText((text) =>
          text
            .setPlaceholder(slot.label)
            .setValue(this.plugin.settings.browsers[slot.id].name)
            .onChange(async (value) => {
              this.plugin.settings.browsers[slot.id].name = value;
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName('実行ファイルのパス')
        .setDesc(
          '例: C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'
        )
        .addText((text) =>
          text
            .setPlaceholder('C:\\Program Files\\...\\browser.exe')
            .setValue(this.plugin.settings.browsers[slot.id].path)
            .onChange(async (value) => {
              this.plugin.settings.browsers[slot.id].path = value;
              await this.plugin.saveSettings();
            })
        );
    }

    containerEl.createEl('p', {
      text:
        'ℹ️ パスが未設定、または指定ファイルが見つからない場合は、' +
        '自動的に既定のブラウザにフォールバックします（通知が表示されます）。',
    });
  }
}
