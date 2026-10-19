# ClassPilot

英语课堂助手（iPhone 网页 App）：上课时自动听、实时中英字幕、识别老师和同学的提问并给出可以照读的简单英文答案；点词查义、按住说中文提问；下课后转写录音、整理问题 / 生词 / 纠错 / 对话练习，进入统一复习队列（连对 3 次算掌握）。

需求文档、界面设计在 Claude 里；本仓库是代码。

## 结构

```
src/shared/   前后端共用：数据类型、提示词、提问优先级、复习规则、OpenRouter→OpenAI 切换规则
src/server/   Node 服务（无第三方运行依赖）：口令登录、AI 调用（Key 只在服务器）、SQLite、课后整理
src/client/   手机网页：语音识别、分段录音、界面
tests/        单元测试 + 服务端端到端测试（假 AI）
scripts/linux 服务器安装、自动更新、状态
scripts/server.ps1  电脑上维护服务器的固定动作（check / install / status / upload-config / restart）
```

## 开发流程

1. 在 `dev` 分支开发，`npm run check` 通过后推送。
2. **先在电脑上本地运行试用**：双击 `scripts\start-local.cmd`（第一次会生成 `config.local.json`，填口令和 Key 后再双击一次），浏览器打开 http://localhost:8095 。
3. 确认没问题后才合并到 `main`。服务器只自动更新 `main`。

## 本地开发（命令行）

需要 Node.js 22.13 以上。

```
npm install
npm run check          # 类型检查 + 测试 + 构建
cp config/config.example.json config.local.json   # 填口令和 Key（不会提交）
CLASSPILOT_CONFIG=./config.local.json CLASSPILOT_STATIC=./dist CLASSPILOT_DATA=./data CLASSPILOT_INSECURE_COOKIE=1 npm start
```

打开 http://localhost:8095 。麦克风需要 HTTPS，本地只能测试界面和接口。

## 部署（云服务器，和 TrendPilot 共用）

1. 复制 `config\config.example.json` 为 `config\config.json`，填好口令、OpenRouter Key、OpenAI Key（这个文件不会提交到 GitHub）。
2. 在电脑上：`scripts\server.cmd install` → 服务器安装 Node、Caddy、构建、注册服务。
3. `scripts\server.cmd upload-config` → 上传配置并启动。
4. iPhone Safari 打开 `https://202-182-114-123.sslip.io`，输入口令，分享 → 添加到主屏幕。

之后推到 `main` 的代码，CI 通过后服务器 3 分钟内自动更新；正在上课时不会重启。`scripts\server.cmd status` 查看状态。

## 配置（服务器 /opt/classpilot/config/config.json）

| 字段 | 说明 |
| --- | --- |
| passcode | 登录口令，至少 6 位 |
| openrouterKey | 优先使用；余额用完自动切到 OpenAI |
| openaiKey | 备用 |
| models | 实时 / 课后整理 / 转写分别用的模型 |
| sttProviderOptions | 转写的额外选项，例如区分说话人 `{"deepgram": {"diarize": true}}`（需要转写模型支持） |
