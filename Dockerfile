FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
RUN mkdir -p /data
ENV NODE_ENV=production AETHERLINK_DATA_DIR=/data PORT=3000 HOST=0.0.0.0
EXPOSE 3000
CMD ["node", "remote.mjs"]
