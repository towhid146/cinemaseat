FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY api/package.json ./api/package.json
COPY frontend/package.json ./frontend/package.json
RUN npm ci
COPY api/tsconfig.json ./api/tsconfig.json
COPY api/src ./api/src
RUN npm run build --workspace api && cp -r api/src/db/migrations api/dist/db/migrations

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
COPY api/package.json ./api/package.json
COPY frontend/package.json ./frontend/package.json
RUN npm ci --omit=dev --workspace api --include-workspace-root=false && npm cache clean --force
COPY --from=build /app/api/dist ./api/dist
USER node
EXPOSE 3000
CMD ["npm", "run", "start:docker", "--workspace", "api"]

