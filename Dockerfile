# syntax=docker/dockerfile:1

# HINWEIS: node_modules wird aus dem Build-Context kopiert statt via `npm ci`
# installiert, weil das Override-Paket @waldner-laboreinrichtungen/node-opcua-server
# auf GitHub Packages liegt und aktuell kein gültiger Token vorhanden ist
# (beide Tokens in .npmrc / ~/.npmrc liefern 401). Mit gültigem Token wäre
# `RUN --mount=type=secret,id=npmrc,target=/app/.npmrc npm ci` die sauberere Variante.

# --- build stage: compile TypeScript -------------------------------
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY interfaces ./interfaces
COPY lib ./lib
COPY utils ./utils
COPY servers ./servers
RUN npm install
RUN npm run build

# --- runtime -------------------------------------------------------
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/out ./out
COPY nodesets ./nodesets

# welcher Server aus der Collection gestartet wird
ENV SERVER=lads-balance
ENV PORT=4844
EXPOSE 4844
CMD ["sh", "-c", "node out/servers/$SERVER/src/server.js"]
