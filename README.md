# 微信回复助手

纯前端的个人自用工具：一个懂人情世故的「微信社交参谋」。一条往下流的时间线：把微信对话按「对方/我」分条贴进底部的交替粘贴框（一框一个人的话，谁说的一目了然），AI 按这个人的档案分析局面、给出可直接复制发送的回复；贴过的消息和回复按轮次冻结在时间线里，底部永远是新的空粘贴框和输入条——对方回了就贴进去接着生成、要求改语气、追问策略，上下文自动延续，视线不用来回翻。

- 聊天式交互（流式输出，可中途停止），分析按局面自适应详略：简单场合直接给几个版本，复杂场合才展开局面分析、避坑、后手策略
- 回复里「可直接发送的消息」渲染成微信绿气泡，一键复制；连发多条自动成组，可整组复制

- 零后端、零构建、零依赖：原生 HTML/CSS/JS（ES modules）
- 所有数据（档案、预设、设置、会话草稿）存浏览器 localStorage
- API Key 只存本机，绝不出现在代码或仓库里
- 手机 ↔ 电脑同步：设置里「导出 JSON / 导入 JSON」（导出不含 Key）

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

手机上可以用浏览器的「添加到主屏幕」，会以独立 App 外壳全屏打开。

## 文件结构

```
index.html          页面骨架（回复 / 档案 两个 tab + 底部输入条）
manifest.json       PWA 壳（添加到主屏幕）
css/style.css       样式（移动优先）
js/storage.js       纯数据层，唯一接触 localStorage 的模块
js/prompts.js       两套提示词（参谋对话 / 总结对话）
js/api.js           浏览器直连大模型 API（流式 SSE + 非流式）、错误分类
js/markdown.js      模型输出解析：markdown 子集渲染 + msg 气泡块拆分
js/ui.js            共享组件：弹窗、toast、复制、人物选择器
js/chat.js          主界面（聊天流、流式渲染、气泡复制、总结链路）
js/manage.js        档案管理页（档案/预设/设置）
```

`storage.js` 不依赖其他模块，将来加新功能（比如素材路由）直接复用同一份档案数据。

## 服务商与模型

在 档案页 → 设置 里选择服务商（会自动填好接口地址和默认模型），再填对应的 API Key：

| 服务商 | 拿 Key 的地方 | 默认模型 |
|---|---|---|
| DeepSeek（默认） | https://platform.deepseek.com | `deepseek-chat` |
| 智谱 GLM | https://open.bigmodel.cn | `glm-4.6` |
| Kimi（月之暗面） | https://platform.moonshot.cn | `kimi-latest` |
| 通义千问 | 阿里云百炼 https://bailian.console.aliyun.com | `qwen-plus` |
| OpenAI（GPT） | https://platform.openai.com（需境外支付方式） | `gpt-5-mini` |
| Claude（Anthropic） | https://platform.claude.com | `claude-sonnet-4-6` |

也支持"自定义（OpenAI 兼容）"：填任意 OpenAI 兼容接口的地址和模型即可。

注意：**豆包（火山方舟）的 API 不允许浏览器跨域**，这种纯前端应用无法直连，所以不在列表里。
