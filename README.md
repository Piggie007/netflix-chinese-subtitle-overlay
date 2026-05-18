# Netflix Chinese Subtitle Overlay

一个 Chrome MV3 扩展原型，用来在 Netflix 播放页把可用英文字幕翻译成中文字幕，并以独立浮层同步显示。

## 工作方式

- 在 `https://www.netflix.com/watch/*` 页面注入一个很小的请求监听脚本。
- 捕获 Netflix 字幕 timedtext 请求。
- 解析 WebVTT 或 TTML/DFXP 字幕。
- 用 OpenAI Chat Completions API 批量翻译成简体或繁体中文。
- 也可以切换到本机 LibreTranslate 免费翻译服务。
- Chrome 138+ 桌面版还可以尝试 Chrome 内置 Translator API，本地翻译、不需要 API key。
- Google Cloud Translation 也可用，速度快，NMT 文本翻译每月前 500,000 字符免费。
- 把翻译结果缓存到浏览器本地存储。
- 根据 `<video>` 的 `currentTime` 实时显示中文字幕浮层。

## 安装

1. 打开 Chrome 的 `chrome://extensions`。
2. 打开右上角「开发者模式」。
3. 点击「加载已解压的扩展程序」。
4. 选择本项目所在目录。

5. 点击扩展图标，填写 OpenAI API Key，然后保存。
6. 刷新 Netflix 播放页，选择英文字幕开始播放。

## 免费本地翻译

设置页里的「翻译服务」可以选择 `Chrome 内置翻译免费`。它使用 Chrome 的 Translator API，首次使用会下载语言包；后续在本机翻译，不需要 OpenAI API key，也不需要 Docker。这个功能依赖 Chrome 138+ 桌面版和浏览器内置模型支持。

也可以选择 `LibreTranslate 本地免费`。默认 endpoint 是：

`http://localhost:5000/translate`

你需要先在本机启动 LibreTranslate。常见 Docker 启动方式：

```sh
docker run -it -p 5000:5000 libretranslate/libretranslate
```

然后在扩展设置里选择 `LibreTranslate 本地免费` 并保存，再刷新 Netflix 播放页。

注意：本地免费翻译不花 OpenAI API 钱，但英译中自然度通常比 GPT 差，繁体中文也取决于 LibreTranslate 模型支持情况。

LibreTranslate 第一次运行或第一次英译中时可能会下载/加载模型；Docker CPU 翻译整集字幕也会比 GPT 慢很多。扩展会尽量批量请求本地服务并缓存结果，第二次打开同一集会快很多。

## Google Cloud Translation

设置页里的「翻译服务」可以选择 `Google Cloud Translation`。你需要：

1. 在 Google Cloud 创建项目。
2. 启用 `Cloud Translation API`。
3. 创建 API key。
4. 给 API key 添加 API restriction，只允许调用 `Cloud Translation API`。
5. 建议设置预算提醒或预算上限。
6. 把 API key 填到扩展设置页保存，然后刷新 Netflix 播放页。

Google Cloud Translation NMT 文本翻译每月前 500,000 字符免费；超过免费额度后会收费。字幕翻译会按发送到 API 的字符数计费，包含空格。扩展有本地缓存，同一集再次播放通常不会再次消耗字符。

## 观影体验建议

- 第一次看某一集时，需要等待字幕分批翻译；已经翻译好的片段会立即显示。
- 第二次看同一集会优先读本地缓存，延迟会明显降低。
- 为了准确率，扩展按字幕块批量翻译，并要求模型保持角色名、术语和语气一致。
- 建议保留「显示英文原字幕」，方便在专名或术语不稳定时对照。

## 当前限制

- 需要 Netflix 当前内容至少有英文字幕轨道。
- Netflix 字幕请求格式可能会变化，真实页面测试后可能需要微调 URL 捕获或解析逻辑。
- API Key 保存在 Chrome sync storage；这是方便个人使用的原型，不建议把它打包分发给别人。
- 翻译服务会产生 API 费用。

## 主要文件

- `manifest.json`：Chrome 扩展配置。
- `src/pageHook.js`：运行在 Netflix 页面上下文里，发现字幕 URL。
- `src/content.js`：解析字幕、翻译、缓存、渲染浮层。
- `src/options.html`：扩展配置界面。
