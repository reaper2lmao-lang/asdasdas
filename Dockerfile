FROM node:20-alpine

WORKDIR /app

# Install build dependencies if needed
COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=3000
ENV HOST=0.0.0.0

EXPOSE 3000

CMD ["node", "server.js"]
