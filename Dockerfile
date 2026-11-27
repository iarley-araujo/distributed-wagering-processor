# ---- deps: todas as dependências (usado pelos testes e ferramentas) ----------
FROM oven/bun:1.4.5 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# ---- test: código + dependências de dev; roda a suíte contra os serviços do compose
FROM deps AS test
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY test ./test
CMD ["bun", "test", "--timeout", "120000"]

# ---- runtime: só dependências de produção ------------------------------------
FROM oven/bun:1.4.5 AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
USER bun
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=3s --retries=10 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:3000/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["bun", "run", "src/main.ts"]
