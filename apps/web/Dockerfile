# Static build of the React app, served by nginx with /api proxied to the
# api service (same-origin deployment: the client uses relative API URLs).
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json ./
COPY apps/web/package.json apps/web/package.json
RUN npm install --workspace @teamform/web --include-workspace-root=false
COPY apps/web apps/web
RUN npm run build --workspace @teamform/web

FROM nginx:1.27-alpine
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
