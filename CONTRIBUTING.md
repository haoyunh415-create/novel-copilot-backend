# 贡献指南

感谢你为鉴来助手贡献力量！这是一个 Apache-2.0 开源项目，欢迎提交 Issue 和 Pull Request。

## 报告 Bug

1. 先搜索 [Issues](../../issues) 看是否已有人报告。
2. 使用「Bug 报告」模板，尽量提供：
   - 复现步骤
   - 预期 vs 实际行为
   - 小说网站（如起点/番茄等）
   - 浏览器及版本（Chrome/Edge）
   - 截图或控制台报错（F12 → Console）
3. 不要粘贴任何包含 API Key、token 或密钥的内容。

## 提议新功能

使用「功能请求」模板，说明使用场景和期望效果。

## 本地开发

### 后端

```bash
git clone https://github.com/haoyunh415-create/novel-copilot-backend.git
cd novel-copilot-backend
python -m venv venv && source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env                             # 填入 DEEPSEEK_API_KEY
python -m uvicorn main:app --host 127.0.0.1 --port 8000
```

### 前端（Chrome 扩展）

`chrome://extensions` → 开启开发者模式 → 加载 `JianLai_Helper/` 目录。

### 测试

```bash
pytest           # 后端 Python 测试
```

## 提交规范

- 提交信息遵循 Conventional Commits：`feat: / fix: / docs: / refactor: / test: / chore:`
- 一个提交只做一件事
- 不要提交 `.env`、`*.db` 等敏感/本地文件（已在 `.gitignore` 中忽略）

## License

你的贡献将以 [Apache License 2.0](LICENSE) 发布。
