FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 AETHERLINK_DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "remote.mjs"]
