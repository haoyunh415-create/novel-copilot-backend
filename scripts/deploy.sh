#!/bin/bash
# ==============================================
#  鉴来助手 - 一键部署脚本 (Ubuntu 20.04/22.04)
#  用法: chmod +x deploy.sh && sudo ./deploy.sh
# ==============================================
set -e

APP_DIR="/opt/novel-copilot-backend"
APP_USER="novelcopilot"
SERVICE_NAME="novel-copilot"

echo "=== 鉴来助手 · 云部署 ==="
echo ""

# ---------- 1. 系统依赖 ----------
echo "[1/6] 安装系统依赖..."
apt-get update -qq
apt-get install -y -qq python3 python3-pip python3-venv git curl

# ---------- 2. 创建专用用户 ----------
echo "[2/6] 创建应用用户..."
if ! id "$APP_USER" &>/dev/null; then
    useradd -r -s /bin/false "$APP_USER"
fi

# ---------- 3. 部署代码 ----------
echo "[3/6] 部署代码..."
REPO_URL="https://github.com/haoyunh415-create/novel-copilot-backend.git"
if [ -d "$APP_DIR" ]; then
    cd "$APP_DIR"
    git pull origin main 2>/dev/null || git pull 2>/dev/null || echo "  (拉取失败，继续使用已有代码)"
else
    git clone "$REPO_URL" "$APP_DIR"
fi

# ---------- 4. Python 环境 ----------
echo "[4/6] 配置 Python 虚拟环境..."
cd "$APP_DIR"
python3 -m venv venv
source venv/bin/activate
pip install -q -r requirements.txt

# ---------- 5. 环境变量 ----------
echo "[5/6] 配置环境变量..."
if [ ! -f "$APP_DIR/.env" ]; then
    echo "  请输入 DeepSeek API Key（在 platform.deepseek.com 获取）:"
    read -r DEEPSEEK_API_KEY
    echo "  请输入 QQ 邮箱地址（用于发送验证码，如 123456789@qq.com）:"
    read -r SMTP_USER
    echo "  请输入 QQ 邮箱授权码（在 QQ邮箱→设置→账户→POP3/SMTP 中生成，不是QQ密码）:"
    read -r SMTP_PASS
    cat > "$APP_DIR/.env" << EOF
DEEPSEEK_API_KEY=$DEEPSEEK_API_KEY
DEEPSEEK_API_URL=https://api.deepseek.com/v1/chat/completions
DEEPSEEK_MODEL=deepseek-chat
SECRET_KEY=$(python3 -c "import secrets; print(secrets.token_hex(32))")
ACCESS_TOKEN_TTL_SECONDS=86400
MOCK_PAYMENTS_ENABLED=false
ADMIN_KEY=$(python3 -c "import secrets; print(secrets.token_hex(12))")
SMTP_HOST=smtp.qq.com
SMTP_PORT=465
SMTP_USER=$SMTP_USER
SMTP_PASS=$SMTP_PASS
EOF
    echo "  .env 已生成"
else
    echo "  .env 已存在，跳过"
fi

# ---------- 6. systemd 服务 ----------
echo "[6/6] 注册系统服务..."
cat > "/etc/systemd/system/$SERVICE_NAME.service" << SYSTEMD
[Unit]
Description=鉴来助手后端
After=network.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
Environment=PATH=$APP_DIR/venv/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$APP_DIR/venv/bin/python -m uvicorn main:app --host 0.0.0.0 --port 8000
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SYSTEMD

chown -R "$APP_USER:$APP_USER" "$APP_DIR"
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

# ---------- 完成 ----------
sleep 2
echo ""
echo "========================================"
echo "  ✅ 部署完成！"
echo "========================================"
echo ""
echo "  后端地址: http://$(curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}'):8000"
echo "  API 文档: http://$(curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}'):8000/docs"
echo "  管理后台: http://$(curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}'):8000/admin"
echo "  管理密钥: $(grep ADMIN_KEY "$APP_DIR/.env" | cut -d= -f2)"
echo ""
echo "  常用命令:"
echo "    systemctl status $SERVICE_NAME   查看状态"
echo "    systemctl restart $SERVICE_NAME  重启"
echo "    journalctl -u $SERVICE_NAME -f   查看日志"
echo ""
