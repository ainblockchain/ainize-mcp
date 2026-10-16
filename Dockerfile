# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY . .
# npm's pinned Git development dependency is private. Only GitHub receives this credential,
# via a transient helper; it is never a URL, build argument or persistent Git credential.
RUN --mount=type=secret,id=GITHUB_READ_TOKEN,required=true \
    GIT_TERMINAL_PROMPT=0 GIT_CONFIG_COUNT=3 \
    GIT_CONFIG_KEY_0=credential.https://github.com.helper \
    GIT_CONFIG_VALUE_0='!f() { printf "username=x-access-token\npassword="; cat /run/secrets/GITHUB_READ_TOKEN; printf "\n"; }; f' \
    GIT_CONFIG_KEY_1=url.https://github.com/.insteadOf GIT_CONFIG_VALUE_1=ssh://git@github.com/ \
    GIT_CONFIG_KEY_2=url.https://github.com/.insteadOf GIT_CONFIG_VALUE_2=git@github.com: \
    npm ci --no-audit --no-fund
ARG AINIZE_DEPLOYMENT_COMMIT
RUN npm run build && node -e 'const s=process.env.AINIZE_DEPLOYMENT_COMMIT; if(!/^[a-f0-9]{40}$/.test(s||"")) throw Error("source commit required"); require("node:fs").writeFileSync("dist/build-commit.txt",s+"\n")'
RUN --network=none npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 3499
CMD ["node", "dist/bin.js", "--http", "3499", "--host", "0.0.0.0"]
