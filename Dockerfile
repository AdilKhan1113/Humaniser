# Small production image. The app has one dependency, so there is nothing to
# build and no toolchain to carry.
FROM node:22-alpine

ENV NODE_ENV=production
# Listen on every interface: inside a container, 127.0.0.1 is unreachable from
# outside it, which looks exactly like a broken deploy.
ENV HOST=0.0.0.0
ENV PORT=8787
# The host's load balancer sets x-forwarded-for, and rate limiting needs it to
# tell callers apart.
ENV TRUST_PROXY=1

WORKDIR /app

# Dependencies first, so a code change does not re-install them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Run as a non-root user.
USER node

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
