# 微信回复助手

纯前端的个人自用工具：把和某个朋友的微信对话手动粘贴进来，加上你对局面的判断，让 Claude 按这个人的档案、用你的口吻生成候选回复。

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
3. 访问 `https://<你的用户名>.github.io/<仓库名>/`，首次点「生成回复」时输入 API Key

手机上可以用浏览器的「添加到主屏幕」，会以独立 App 外壳全屏打开。

## 文件结构

```
index.html          页面骨架（回复 / 档案 两个 tab）
manifest.json       PWA 壳（添加到主屏幕）
css/style.css       样式（移动优先）
js/storage.js       纯数据层，唯一接触 localStorage 的模块
js/prompts.js       两套提示词（生成回复 / 总结对话）
js/api.js           浏览器直连 Anthropic API、错误分类、JSON 解析兜底
js/ui.js            共享组件：弹窗、toast、复制、人物选择器
js/chat.js          主界面（交替粘贴框、生成候选、总结链路）
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
