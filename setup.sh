#!/usr/bin/env bash
set -euo pipefail

# 鉴来助手 一键初始化脚本（Linux/macOS）
cd "$(dirname "$0")"

echo "==> 创建虚拟环境"
python3 -m venv venv

echo "==> 安装依赖"
./venv/bin/pip install --upgrade pip
./venv/bin/pip install -r requirements.txt

if [ ! -f .env ]; then
  echo "==> 生成 .env（请填写 DEEPSEEK_API_KEY 等）"
  cp .env.example .env
else
  echo "==> 已存在 .env，跳过（不覆盖）"
fi

echo ""
echo "完成。下一步："
echo "  1. 编辑 .env，填入 DEEPSEEK_API_KEY、SECRET_KEY、ADMIN_KEY"
echo "  2. 启动： ./venv/bin/python -m uvicorn main:app --host 0.0.0.0 --port 8000"
