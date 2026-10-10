FROM node:22-alpine

WORKDIR /app

# Instalar dependências
COPY package*.json ./
RUN npm ci --omit=dev

# Copiar código fonte
COPY . .

# Expor porta padrão
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
