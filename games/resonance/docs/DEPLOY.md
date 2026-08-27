# RESONANCE 部署手册

游戏本体是**零依赖、零构建**的纯静态站点。`package.json` 里的 jsdom/playwright
只用于跑测试，部署时**不需要 `npm install`**。

需要上传的就是这些文件：

```
index.html
style.css
src/            platform.js rng.js icons.js relics.js audio.js game.js render.js main.js
```

`docs/` 和 `test*.js` 不需要上传（它们是给开发者看的）。

---

## 目录

1. [Web 部署（5 分钟）](#1-web-部署)
2. [平台适配层是怎么工作的](#2-平台适配层)
3. [iOS App](#3-ios-app)
4. [Android App](#4-android-app)
5. [鸿蒙 App（HarmonyOS NEXT）](#5-鸿蒙-app)
6. [微信小游戏](#6-微信小游戏)
7. [AppLovin MAX 接入](#7-applovin-max)
8. [backupSave 协议](#8-backupsave-协议)
9. [上线前检查清单](#9-上线前检查清单)

---

## 1. Web 部署

### 最快的方式：本地直接玩

```bash
cd games/resonance
python3 -m http.server 8080
# 打开 http://localhost:8080
```

> 注意：`index.html` 用的都是相对路径，所以直接双击打开文件也能玩。
> 但 `file://` 协议下 localStorage 的隔离规则在部分浏览器上比较怪，
> 存档可能不稳。要正经玩就起个 http server。

### Cloudflare Pages

```bash
npx wrangler pages deploy games/resonance --project-name=resonance
```

### GitHub Pages / Netlify / Vercel

直接把 `games/resonance` 目录当作站点根目录发布即可，**不要配置任何构建命令**
（build command 留空，output directory 填 `games/resonance`）。

### 任意静态服务器 / Nginx

```nginx
location / {
    root /var/www/resonance;
    try_files $uri $uri/ /index.html;
}
```

只有一条要求：`.js` 要用 `text/javascript` 或 `application/javascript` 返回。
所有正常的服务器默认都对。

---

## 2. 平台适配层

所有跨平台差异都收在 **`src/platform.js`** 这一个文件里。业务代码
（`main.js` 等）只认识 `Platform.*`，不认识 `wx`、不认识 `webkit`。

这样做的代价是多一层间接；收益是**新增一个平台 = 新增一个 adapter**，
不需要在业务代码里到处加 `if (isWeChat)`。

宿主只需要提供四类能力：

| 能力 | Web | 微信 | 原生壳 |
|---|---|---|---|
| 存储 | localStorage | wx.setStorageSync | WebView 的 localStorage |
| 分享 | navigator.share / 剪贴板 | wx.shareAppMessage | 原生分享面板 |
| 震动 | navigator.vibrate | wx.vibrateShort | 原生 haptics |
| 广告/内购 | 无 | wx SDK | AppLovin + StoreKit/Billing |

### 调试各平台分支

在桌面浏览器上加 URL 参数就能强制走某个 adapter：

```
http://localhost:8080/?platform=wechat
http://localhost:8080/?platform=native
http://localhost:8080/?platform=web
```

原生桥不存在时会走兜底（返回 `bridge-missing`），不会崩，所以
`?platform=native` 在桌面上也能正常玩，只是广告/分享走降级路径。

### 原生桥协议（三端共用一份）

JS → 原生，发一条 JSON：

```json
{ "type": "showRewarded", "id": "r7", "payload": { "placement": "hint" } }
```

原生处理完 → 回调 JS（**必须按名字调用这个全局函数**）：

```js
window.__resonanceNativeCallback("r7", { "ok": true, "shown": true, "rewarded": true });
```

`type` 的全集：`share` `vibrate` `showInterstitial` `showRewarded`
`purchase` `exit` `backupSave`。

超时保护：JS 侧 8 秒没收到回调就自己 resolve 成 `{ok:false, reason:'timeout'}`。
所以**原生崩了不会卡死游戏**——但也意味着原生侧应尽量回调，哪怕是回一个失败。

---

## 3. iOS App

新建一个 iOS 项目，把 `games/resonance` 整个目录拖进去（选 **Create folder
references**，不要选 Create groups——后者会把目录结构拍平，相对路径就断了）。

```swift
import UIKit
import WebKit

class GameViewController: UIViewController, WKScriptMessageHandler {
    private var webView: WKWebView!

    override func viewDidLoad() {
        super.viewDidLoad()

        let config = WKWebViewConfiguration()
        // 名字必须是 RESONANCE —— platform.js 就是按这个名字找桥的
        config.userContentController.add(self, name: "RESONANCE")
        config.allowsInlineMediaPlayback = true
        // 游戏用 WebAudio 做程序化音效, 需要允许无手势自动播放
        config.mediaTypesRequiringUserActionForPlayback = []

        webView = WKWebView(frame: .zero, configuration: config)
        webView.scrollView.isScrollEnabled = false   // 棋盘拖拽不能被页面滚动抢走
        webView.scrollView.bounces = false
        webView.isOpaque = false
        webView.backgroundColor = .black             // 避免首帧白闪
        view.addSubview(webView)
        webView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])

        let url = Bundle.main.url(forResource: "index",
                                  withExtension: "html",
                                  subdirectory: "resonance")!
        webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
    }

    // MARK: 桥: JS -> 原生
    func userContentController(_ ucc: WKUserContentController,
                              didReceive message: WKScriptMessage) {
        guard let msg = message.body as? [String: Any],
              let type = msg["type"] as? String,
              let id = msg["id"] as? String else { return }
        let payload = msg["payload"] as? [String: Any]

        switch type {
        case "share":
            let text = (payload?["text"] as? String) ?? "RESONANCE"
            let vc = UIActivityViewController(activityItems: [text],
                                              applicationActivities: nil)
            // iPad 上必须给 sourceView, 否则会崩
            vc.popoverPresentationController?.sourceView = view
            present(vc, animated: true) { self.reply(id, ["ok": true]) }

        case "vibrate":
            let ms = (payload?["ms"] as? Int) ?? 10
            // 不要直接把毫秒映射成时长 —— iOS 没有这个 API。按强度分档。
            let style: UIImpactFeedbackGenerator.FeedbackStyle =
                ms >= 30 ? .heavy : (ms >= 15 ? .medium : .light)
            UIImpactFeedbackGenerator(style: style).impactOccurred()
            reply(id, ["ok": true])

        case "showInterstitial":
            AdBridge.shared.showInterstitial { shown in
                self.reply(id, ["ok": true, "shown": shown])
            }

        case "showRewarded":
            let placement = (payload?["placement"] as? String) ?? ""
            AdBridge.shared.showRewarded(placement) { shown, rewarded in
                self.reply(id, ["ok": true, "shown": shown, "rewarded": rewarded])
            }

        case "purchase":
            let pid = (payload?["productId"] as? String) ?? ""
            IAPBridge.shared.buy(pid) { ok in
                self.reply(id, ["ok": ok])
            }

        case "backupSave":
            if let json = payload?["data"] as? String {
                UserDefaults.standard.set(json, forKey: "resonance.backup")
            }
            reply(id, ["ok": true])

        case "exit":
            reply(id, ["ok": false])   // iOS 不允许 App 自杀, 如实返回失败

        default:
            reply(id, ["ok": false, "reason": "unknown-type"])
        }
    }

    // MARK: 桥: 原生 -> JS
    private func reply(_ id: String, _ result: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: result),
              let json = String(data: data, encoding: .utf8) else { return }
        // 注意这里传的是 JSON 字符串; platform.js 会自己 JSON.parse
        let js = "window.__resonanceNativeCallback('\(id)', \(escapeForJS(json)));"
        DispatchQueue.main.async { self.webView.evaluateJavaScript(js) }
    }

    private func escapeForJS(_ s: String) -> String {
        // 作为 JS 字符串字面量传, 让 platform.js 走 JSON.parse 分支
        let esc = s.replacingOccurrences(of: "\\", with: "\\\\")
                   .replacingOccurrences(of: "'", with: "\\'")
        return "'\(esc)'"
    }
}
```

### 上架注意

* **必须有内购之外的完整可玩内容**——本作全部内容免费可玩，符合要求。
* 隐私清单（Privacy Manifest）：如果接了 AppLovin，需要在
  `PrivacyInfo.xcprivacy` 里申报 IDFA 用途，并处理 ATT 授权弹窗。
* 若**不接广告**（推荐的首发策略），游戏不收集任何数据，隐私问卷全填“不收集”，
  审核会快很多。

---

## 4. Android App

把 `games/resonance` 放到 `app/src/main/assets/resonance/`。

```kotlin
import android.webkit.*
import org.json.JSONObject

class GameActivity : AppCompatActivity() {
    private lateinit var web: WebView

    override fun onCreate(s: Bundle?) {
        super.onCreate(s)
        web = WebView(this)
        setContentView(web)

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true          // localStorage 存档必需
            mediaPlaybackRequiresUserGesture = false  // WebAudio 音效
            allowFileAccess = false           // 不需要, 关掉更安全
        }
        web.setBackgroundColor(0xFF000000.toInt())  // 避免首帧白闪
        web.overScrollMode = WebView.OVER_SCROLL_NEVER

        // 名字必须是 RESONANCE_NATIVE
        web.addJavascriptInterface(Bridge(), "RESONANCE_NATIVE")
        web.loadUrl("file:///android_asset/resonance/index.html")
    }

    inner class Bridge {
        @JavascriptInterface
        fun postMessage(raw: String) {
            val msg = JSONObject(raw)
            val type = msg.optString("type")
            val id = msg.optString("id")
            val payload = msg.optJSONObject("payload")

            when (type) {
                "share" -> {
                    val text = payload?.optString("text") ?: "RESONANCE"
                    val i = Intent(Intent.ACTION_SEND).apply {
                        this.type = "text/plain"
                        putExtra(Intent.EXTRA_TEXT, text)
                    }
                    startActivity(Intent.createChooser(i, null))
                    reply(id, """{"ok":true}""")
                }
                "vibrate" -> {
                    val ms = payload?.optLong("ms") ?: 10L
                    val v = getSystemService(Vibrator::class.java)
                    if (Build.VERSION.SDK_INT >= 26) {
                        v.vibrate(VibrationEffect.createOneShot(
                            ms, VibrationEffect.DEFAULT_AMPLITUDE))
                    } else {
                        @Suppress("DEPRECATION") v.vibrate(ms)
                    }
                    reply(id, """{"ok":true}""")
                }
                "showInterstitial" -> AdBridge.showInterstitial(this@GameActivity) { shown ->
                    reply(id, """{"ok":true,"shown":$shown}""")
                }
                "showRewarded" -> {
                    val placement = payload?.optString("placement") ?: ""
                    AdBridge.showRewarded(this@GameActivity, placement) { shown, rewarded ->
                        reply(id, """{"ok":true,"shown":$shown,"rewarded":$rewarded}""")
                    }
                }
                "purchase" -> {
                    val pid = payload?.optString("productId") ?: ""
                    BillingBridge.buy(this@GameActivity, pid) { ok ->
                        reply(id, """{"ok":$ok}""")
                    }
                }
                "backupSave" -> {
                    getSharedPreferences("resonance", MODE_PRIVATE).edit()
                        .putString("backup", payload?.optString("data")).apply()
                    reply(id, """{"ok":true}""")
                }
                "exit" -> { reply(id, """{"ok":true}"""); finish() }
                else -> reply(id, """{"ok":false,"reason":"unknown-type"}""")
            }
        }
    }

    private fun reply(id: String, json: String) {
        // JavascriptInterface 的回调在子线程, evaluateJavascript 必须回主线程
        runOnUiThread {
            web.evaluateJavascript(
                "window.__resonanceNativeCallback('$id', $json);", null)
        }
    }

    // 返回键: 让游戏先自己退一层 (对局中 -> 菜单), 而不是直接杀掉 App。
    // 注意这里调用的是 main.js 暴露的 ResonanceApp.goBack(), 不是 Platform 的
    // 方法 —— Platform 只负责宿主能力(存储/分享/广告), 界面栈是业务概念。
    // 对局中按返回不会丢进度: goBack 会先存档再退到菜单。
    override fun onBackPressed() {
        web.evaluateJavascript(
            "(function(){ var A = window.ResonanceApp; return (A && A.goBack) ? !!A.goBack() : false; })()"
        ) { r ->
            if (r != "true") super.onBackPressed()   // 游戏没消费掉就正常退出
        }
    }
}
```

---

## 5. 鸿蒙 App

HarmonyOS NEXT 的 ArkWeb 组件通过 `javaScriptProxy` 注入对象。**协议和
Android 完全一样**（同样叫 `RESONANCE_NATIVE`、同样的 `postMessage`），
所以 `platform.js` 不需要为鸿蒙加任何分支。

把 `games/resonance` 放进 `entry/src/main/resources/rawfile/resonance/`。

```typescript
import web_webview from '@ohos.web.webview';
import vibrator from '@ohos.vibrator';

@Entry
@Component
struct GamePage {
  controller: web_webview.WebviewController = new web_webview.WebviewController();

  // 这个对象会被注入成 window.RESONANCE_NATIVE
  bridge = {
    postMessage: (raw: string) => {
      const msg = JSON.parse(raw);
      const { type, id, payload } = msg;

      switch (type) {
        case 'vibrate':
          vibrator.startVibration(
            { type: 'time', duration: payload?.ms ?? 10 },
            { usage: 'touch' }
          ).then(() => this.reply(id, { ok: true }))
           .catch(() => this.reply(id, { ok: false }));
          break;

        case 'share':
          // 通过 ShareKit 拉起系统分享
          this.systemShare(payload?.text ?? 'RESONANCE')
            .then(() => this.reply(id, { ok: true }))
            .catch(() => this.reply(id, { ok: false }));
          break;

        case 'backupSave':
          // 用 preferences 存一份, 防止 WebView 缓存被清
          this.savePrefs(payload?.data);
          this.reply(id, { ok: true });
          break;

        case 'showInterstitial':
        case 'showRewarded':
          // 华为广告服务; 未接入时如实返回 false, 游戏会自动降级
          this.reply(id, { ok: false, shown: false, reason: 'not-integrated' });
          break;

        case 'exit':
          this.reply(id, { ok: true });
          break;

        default:
          this.reply(id, { ok: false, reason: 'unknown-type' });
      }
    }
  };

  reply(id: string, result: object) {
    this.controller.runJavaScript(
      `window.__resonanceNativeCallback('${id}', ${JSON.stringify(JSON.stringify(result))});`
    );
  }

  build() {
    Web({
      src: $rawfile('resonance/index.html'),
      controller: this.controller
    })
      .javaScriptAccess(true)
      .domStorageAccess(true)        // localStorage 存档必需
      .mediaPlayGestureAccess(false) // 允许 WebAudio 自动播放
      .horizontalScrollBarAccess(false)
      .verticalScrollBarAccess(false)
      .javaScriptProxy({
        object: this.bridge,
        name: 'RESONANCE_NATIVE',    // 必须与 Android 同名
        methodList: ['postMessage'],
        controller: this.controller
      })
      .width('100%')
      .height('100%')
  }
}
```

> 鸿蒙上唯一容易踩的坑是 `domStorageAccess(true)` 忘了开——存档会静默失效，
> 游戏能玩但每次都从头开始。

---

## 6. 微信小游戏

微信小游戏**没有 DOM**，只有一个 canvas。而本作的 UI（菜单、遗物卡、
计分台）是真实的 DOM 元素，不是画在 canvas 上的。所以不能直接把文件丢进去。

两条路：

### 方案 A：微信小程序 + web-view（推荐，改动最小）

把 Web 版部署到 HTTPS 域名，然后：

```json
// app.json —— 域名必须先在微信后台「业务域名」里备案
{ "pages": ["pages/game/game"] }
```

```html
<!-- pages/game/game.wxml -->
<web-view src="https://your-domain.com/resonance/index.html"></web-view>
```

**代价**：`web-view` 里拿不到 `wx.*` 的大部分能力（激励视频不可用），
且必须是已备案域名。适合先上线验证，不适合做广告变现。

### 方案 B：小游戏 + DOM 适配层（要干活）

小游戏环境需要一个 DOM 适配库（社区方案如 `minigame-canvas-engine`
或自己写一层 shim）。这条路的工作量主要不在游戏逻辑上——`game.js`
是纯逻辑，零 DOM 依赖，可以直接跑——而在于把 `main.js` 里的
DOM UI 重写成 canvas 绘制。

`platform.js` 侧已经就绪：`WeChatAdapter` 会自动接管存储、分享、震动、广告。
只需在小游戏入口先注入 SDK 实例：

```js
// game.js (小游戏入口)
require('./src/platform.js');

const interstitial = wx.createInterstitialAd({ adUnitId: 'adunit-xxxx' });
const rewarded = wx.createRewardedVideoAd({ adUnitId: 'adunit-yyyy' });

Platform.configure({
  wx: { interstitial, rewarded },
  ads: {
    enabled: true,
    interstitialAfterRun: true,
    rewardedHint: true,
    rewardedReroll: true,
  },
});
```

> `WeChatAdapter` 内部对 `onClose` 做了 `offClose` 配对。这不是洁癖：
> 微信的 `onClose` 是**累加**注册的，忘了解绑会导致第二次看广告时
> 上一次的回调也被触发——发两次奖励，或者更糟，发一次奖励再报一次失败。

---

## 7. AppLovin MAX

### 为什么用 MAX

它是聚合层（mediation），同时接入多家广告源竞价，eCPM 通常比单接一家高。
但它只是**供给侧**——频次由我们自己控制，不交给它。

### 频次控制在我们这边，不在 SDK 那边

`src/platform.js` 里这两个常量是**硬编码**的：

```js
const MIN_INTERSTITIAL_GAP_S = 150; // 两次插屏之间至少 150 秒
const MIN_RUNS_BEFORE_FIRST_AD = 3; // 前 3 局绝不插屏
```

写死而不是做成远端配置，是一个有意的决定：这条底线不应该能被
运营在后台随手调掉。`test.js` 里有断言钉住它（`>= 120` 秒、`>= 3` 局），
改小了测试会红。

同理，激励视频的位置是**硬编码白名单**，只有 `hint` 和 `reroll` 两个：

```js
const allowed = { hint: 'rewardedHint', reroll: 'rewardedReroll' };
```

`revive`、`betterPiece`、`skipLevel` 这类位置会被直接拒绝，返回
`placement-forbidden`。原因写在代码注释里：**看广告能改变结果，
「同种子可复现」就成了假话**，而那是本作唯一的护城河。

### iOS 集成骨架

```swift
import AppLovinSDK

final class AdBridge: NSObject, MAAdDelegate, MARewardedAdDelegate {
    static let shared = AdBridge()
    private var interstitial: MAInterstitialAd?
    private var rewarded: MARewardedAd?
    private var interCb: ((Bool) -> Void)?
    private var rewardCb: ((Bool, Bool) -> Void)?
    private var didEarnReward = false

    func start() {
        let cfg = ALSdkInitializationConfiguration(sdkKey: "YOUR_SDK_KEY")
        ALSdk.shared().initialize(with: cfg) { _ in
            self.interstitial = MAInterstitialAd(adUnitIdentifier: "INTER_UNIT")
            self.interstitial?.delegate = self
            self.interstitial?.load()

            self.rewarded = MARewardedAd.shared(withAdUnitIdentifier: "REWARD_UNIT")
            self.rewarded?.delegate = self
            self.rewarded?.load()
        }
    }

    func showInterstitial(_ cb: @escaping (Bool) -> Void) {
        guard let ad = interstitial, ad.isReady else { cb(false); return }
        interCb = cb
        ad.show()
    }

    func showRewarded(_ placement: String, _ cb: @escaping (Bool, Bool) -> Void) {
        guard let ad = rewarded, ad.isReady else { cb(false, false); return }
        rewardCb = cb
        didEarnReward = false
        ad.show()
    }

    // 关键: 只有真的看完才算 rewarded。没看完就发奖励会破坏平衡。
    func didRewardUser(for ad: MAAd, with reward: MAReward) { didEarnReward = true }
    func didHideAd(_ ad: MAAd) {
        rewardCb?(true, didEarnReward); rewardCb = nil
        interCb?(true); interCb = nil
        // 关闭即预加载下一条, 否则下次必然 isReady == false
        (ad.adUnitIdentifier == "REWARD_UNIT" ? rewarded?.load() : interstitial?.load())
    }
    func didFailToDisplay(_ ad: MAAd, withError error: MAError) {
        rewardCb?(false, false); rewardCb = nil
        interCb?(false); interCb = nil
    }
    func didLoad(_ ad: MAAd) {}
    func didFailToLoadAd(forAdUnitIdentifier id: String, withError error: MAError) {}
    func didClick(_ ad: MAAd) {}
    func didDisplay(_ ad: MAAd) {}
}
```

### 开启广告

Web 版**默认全关**（`test.js` 有断言保证），原生壳里显式打开：

```js
Platform.configure({
  ads: {
    enabled: true,
    interstitialAfterRun: true,
    rewardedHint: true,
    rewardedReroll: true,
  },
});
```

---

## 8. backupSave 协议

原生壳里存档走 WebView 自带的 localStorage——它在三端都可用，而且比
每次跨桥读写快得多。缺点是**用户清缓存/清应用数据时会丢**。

所以原生壳应该定期把存档备份到原生侧。JS 主动发起：

```js
// 在原生壳里注入这段, 或加到 platform.js 的 onPause 里
setInterval(() => {
  const blob = JSON.stringify({
    meta: localStorage.getItem('resonance.meta'),
    run: localStorage.getItem('resonance.run'),
  });
  Platform._adapters.NativeAdapter._call('backupSave', { data: blob });
}, 60000);
```

原生侧存到 UserDefaults / SharedPreferences / preferences。
恢复时机是 WebView 加载前：如果原生有备份而 localStorage 是空的，
就先注入回去。

```swift
// iOS: 在 loadFileURL 之前注入
if let backup = UserDefaults.standard.string(forKey: "resonance.backup") {
    let js = """
    (function(){
      if (!localStorage.getItem('resonance.meta')) {
        var b = \(escapeForJS(backup));
        var o = JSON.parse(b);
        if (o.meta) localStorage.setItem('resonance.meta', o.meta);
        if (o.run)  localStorage.setItem('resonance.run', o.run);
      }
    })();
    """
    let script = WKUserScript(source: js,
                             injectionTime: .atDocumentStart,
                             forMainFrameOnly: true)
    config.userContentController.addUserScript(script)
}
```

> 注意那个 `if (!localStorage.getItem(...))` 判断：只在本地**没有**存档时
> 才恢复。少了它，备份会覆盖掉更新的本地进度——玩家会发现自己的成绩退回去了。

---

## 9. 上线前检查清单

跑一遍测试：

```bash
cd games/resonance
npm install          # 只为测试; 部署不需要
npm run test:logic   # 112 项: 逻辑/平衡/商业化底线/终局
npm run test:dom     # 47 项: 真实 DOM 交互
npm run test:layout  # 7 种视口的布局校验
npm run shots        # 截图 + 控制台错误检查 (需要先 npm start)
```

数值可复算（游戏里对玩家宣称「实测分布 · 可复算」，这句话必须是真的）：

```bash
node docs/benchmark.js      # BEAT_PCT / STREAK_GRACE / MERCY 阈值
node docs/model.js          # 商业模型: 内容深度 / 留存 / LTV / 敏感度
```

发布前逐项确认：

- [ ] Web 版 `Platform.ads.enabled === false`（默认就是，别手动开）
- [ ] 原生壳里 `mediaPlaybackRequiresUserGesture = false`，否则音效全哑
- [ ] 原生壳里 `domStorageEnabled / domStorageAccess = true`，否则存档静默失效
- [ ] WebView 背景设为黑色，避免首帧白闪
- [ ] 关闭 WebView 的滚动与 overscroll，否则拖拽棋子会被页面滚动抢走
- [ ] 激励视频只用于 `hint` / `reroll`（代码会拦，但别去改代码）
- [ ] 若接广告：ATT / 隐私清单 / 用户同意流程按各商店要求处理完
- [ ] 若不接广告：隐私问卷可全填「不收集」，本作不产生任何网络请求
