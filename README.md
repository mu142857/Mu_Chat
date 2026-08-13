# 微信回复助手

纯前端的个人自用工具：一个懂人情世故的「微信社交参谋」。一条往下流的时间线：把微信对话按「对方/我」分条贴进底部的交替粘贴框（一框一个人的话，谁说的一目了然），AI 按这个人的档案分析局面、给出可直接复制发送的回复；贴过的消息和回复按轮次冻结在时间线里，底部永远是新的空粘贴框和输入条——对方回了就贴进去接着生成、要求改语气、追问策略，上下文自动延续，视线不用来回翻。

- 聊天式交互（流式输出，可中途停止），分析按局面自适应详略：简单场合直接给几个版本，复杂场合才展开局面分析、避坑、后手策略
- 回复里「可直接发送的消息」渲染成微信绿气泡，一键复制；连发多条自动成组，可整组复制

- 零后端、零构建、零依赖：原生 HTML/CSS/JS（ES modules）
- **档案存本地文件** `data/profiles.js`，包含三层：`me`（我的档案：完整的「我是谁」，只给参谋看）、`categories`（人物类别：给没建档案的人当默认设定，每类带 `reveal` 露出策略——对这类人我露什么藏什么）、`profiles`（具体的人，`category` 字段继承类别打法）。直接编辑文件（或叫 Claude 改），刷新页面生效；该文件被 .gitignore 忽略，不会被提交或发布。新机器上把 `data/profiles.example.js` 复制为 `data/profiles.js` 起步
- 梗库：收藏你觉得妙的梗和好句（页面里随手存，或写进档案文件的 `memes`），生成回复时随机带几条给模型当风格参考
- 锁屏密码（可选，设置里开启）：打开页面先输密码，浏览器可记住。定位是挡顺手翻看的门帘，数据本身不加密
- 其余数据（梗库、设置、会话草稿）存浏览器 localStorage；API Key 只存本机，绝不出现在代码或仓库里
- **手机上用**：档案文件不会被发布，所以线上版默认是空的。在电脑上「档案页 → 导出档案」得到一份 JSON，传到手机后在线上版「档案页 → 导入档案」（选文件或直接粘贴），数据只存在手机浏览器里。手机端只读——改档案永远在电脑上改文件，改完重新导出导入一次。档案文件优先级高于导入的副本，所以真相源只有电脑上那一份
- 设置里另有「导出 JSON / 导入 JSON」，只含梗库和服务商设置（不含 Key、不含档案）

## 本地运行

需要用 http 访问（ES modules 在 file:// 下会被浏览器拦截）：

```bash
python3 -m http.server 8000
```

然后打开 http://localhost:8000

## 部署到 GitHub Pages

1. 把本目录 push 到一个 GitHub 仓库（代码里没有任何密钥，公开仓库也安全）
2. 仓库 Settings → Pages → Source 选 `main` 分支根目录，保存
3. 访问 `https://<你的用户名>.github.io/<仓库名>/`，首次发送消息时输入 API Key

注意：`data/profiles.js`（我的档案 + 类别 + 朋友档案）被 .gitignore 忽略，**不会跟着发布**——
GitHub Pages 的网址是公开的，档案里全是私人内容，绝不能提交。线上版打开时没有档案是正常的，
要用就按上面的「导出档案 → 导入档案」拷过去，数据只落在那台设备的浏览器里。

手机上可以用浏览器的「添加到主屏幕」，会以独立 App 外壳全屏打开。
手机里存了档案之后，建议在设置里开启锁屏密码。

## 文件结构

```
index.html               页面骨架（回复 / 档案 两个 tab + 底部输入条）
manifest.json            PWA 壳（添加到主屏幕）
css/style.css            样式（移动优先）
data/profiles.js         我的档案 + 人物类别 + 朋友档案 + 文件版梗库（本地私有，gitignore，不入库）
data/profiles.example.js 档案文件模板（新机器复制它起步）
js/storage.js            纯数据层：加载档案文件 + 唯一接触 localStorage 的模块
js/prompts.js            两套提示词（参谋对话 / 总结对话）+ 梗库注入
js/api.js                浏览器直连大模型 API（流式 SSE + 非流式）、错误分类
js/markdown.js           模型输出解析：markdown 子集渲染 + msg 气泡块拆分
js/ui.js                 共享组件：弹窗、toast、复制、人物选择器
js/lock.js               锁屏（打开页面的密码门帘）
js/chat.js               主界面（聊天流、流式渲染、气泡复制、总结链路）
js/manage.js             档案管理页（档案/我/类别只读展示、旧档案迁移、梗库、设置）
```

`storage.js` 不依赖其他模块，将来加新功能（比如素材路由）直接复用同一份档案数据。

旧版本把档案存在浏览器 localStorage 里；升级后档案页会出现迁移卡片，
按提示「下载档案文件 → 放进 data/ → 刷新确认 → 清除旧档案」即可一次迁完。
「总结」生成的要点现在弹窗展示并可复制，自己贴进 `data/profiles.js` 的 notes（或直接叫 Claude 归档）。

## 服务商与模型

在 档案页 → 设置 里选择服务商（会自动填好接口地址和默认模型），再填对应的 API Key：

| 服务商 | 拿 Key 的地方 | 默认模型 |
|---|---|---|
| DeepSeek（默认） | https://platform.deepseek.com | `deepseek-chat` |
| 智谱 GLM | https://open.bigmodel.cn | `glm-4.6` |
| Kimi（月之暗面） | https://platform.moonshot.cn | `kimi-latest` |
| 通义千问 | 阿里云百炼 https://bailian.console.aliyun.com | `qwen-plus` |
| OpenAI（GPT） | https://platform.openai.com（需境外支付方式） | `gpt-5-mini` |
| Gemini（Google） | Google AI Studio https://aistudio.google.com/apikey | `gemini-2.5-pro` |

每个服务商都带一份常用模型清单，设置里的「模型」是下拉菜单，每项注明快慢／贵贱／语气取向，随时可换。
清单里没有的型号选「自定义…」手填 ID 即可。
| Claude（Anthropic） | https://platform.claude.com | `claude-sonnet-4-6` |

也支持"自定义（OpenAI 兼容）"：填任意 OpenAI 兼容接口的地址和模型即可。

注意：**豆包（火山方舟）的 API 不允许浏览器跨域**，这种纯前端应用无法直连，所以不在列表里。
