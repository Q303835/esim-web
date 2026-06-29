# 1. 使用 Node.js 镜像
FROM node:18-bookworm-slim

# 2. 安装 lpac 运行所需的依赖和 socat
RUN apt-get update && apt-get install -y \
    libpcsclite1 \
    pcscd \
    socat \
    libcurl4 \
    && rm -rf /var/lib/apt/lists/*

# 3. 设置工作目录
WORKDIR /app

# 4. 复制 Node.js 项目文件并安装依赖
COPY package*.json ./
RUN npm install

# 5. 复制剩余所有文件 (修复了换行问题)
COPY . .

# 6. 多架构处理并清理冗余文件
ARG TARGETARCH
RUN if [ "$TARGETARCH" = "amd64" ]; then \
        mv lpac-linux-amd64 lpac; \
    elif [ "$TARGETARCH" = "arm64" ]; then \
        mv lpac-linux-arm64 lpac; \
    else \
        echo "Unsupported architecture: $TARGETARCH" && exit 1; \
    fi && \
    chmod +x lpac && \
    rm -f lpac-linux-amd64 lpac-linux-arm64

# 7. 配置底层引擎的环境变量
ENV LPAC_APDU=at
ENV LPAC_APDU_AT_DEVICE=/dev/ttyV0
ENV WEB_PORT=3200
ENV TUNNEL_PORT=3100
ENV PROXY_PORT=3300

EXPOSE 3200 3100 3300

CMD ["node", "server.js"]