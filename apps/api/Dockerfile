FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY apps/api/package.json apps/api/package.json
RUN npm install --workspace @teamform/api --include-workspace-root=false
COPY db db
COPY apps/api apps/api
EXPOSE 3000
CMD ["sh", "-c", "node db/migrate.mjs && npx tsx apps/api/src/server.ts"]
