FROM node:20-bookworm-slim

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

ENV NODE_ENV=production
# Render, Railway and Fly all inject PORT; the server reads it.
EXPOSE 3000
CMD ["node", "server.js"]
