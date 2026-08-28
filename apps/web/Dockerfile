# The web app is static once built; it is served by nginx with security headers.
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
# The API origin is baked in at build time, so each environment builds its own image.
ARG VITE_API_URL
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build

FROM nginx:1.27-alpine AS runtime
ARG VITE_API_URL
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY security-headers.conf /etc/nginx/security-headers.conf

# The content security policy names the API origin rather than allowing any https host,
# so it is substituted from the same build argument the client was compiled against -
# the two can never disagree. Substitution happens at build time, and nginx would refuse
# to start on an unsubstituted ${...}, so a missed build argument fails loudly here
# instead of shipping a policy with a hole in it.
RUN set -eu; \
    api_origin="$(printf '%s' "${VITE_API_URL:-}" | sed -E 's#^(https?://[^/]+).*#\1#')"; \
    [ -n "$api_origin" ] || { echo 'VITE_API_URL build argument is required'; exit 1; }; \
    ws_origin="$(printf '%s' "$api_origin" | sed -E 's#^http#ws#')"; \
    sed -i "s#\${API_ORIGIN}#$api_origin#g; s#\${API_WS_ORIGIN}#$ws_origin#g" \
      /etc/nginx/security-headers.conf; \
    grep -q '\${' /etc/nginx/security-headers.conf && { echo 'unsubstituted placeholder'; exit 1; } || true

EXPOSE 8080
